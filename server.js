const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
// Load Firebase service account from env var (production) or local file (dev).
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
  );
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

const app = express();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id
});

const db = admin.firestore();

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// Rate limiting — 200 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

// Auth middleware — verifies Firebase ID token from Authorization header
async function verifyAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));
    req.uid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.use('/api', verifyAuth);

// Haversine distance in meters between two lat/lng points
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function createNotification(userId, type, message) {
  await db.collection('notifications').add({
    userId, type, message, read: false, createdAt: new Date()
  });
}

// ── FCM token registration ────────────────────────────────────────────────────

// Store/update the FCM push token for the authenticated user's device.
// A user may have multiple devices; we keep up to 10 tokens (deduped).
app.post('/api/users/fcm-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const userRef = db.collection('users').doc(req.uid);
    const userDoc = await userRef.get();
    const existing = userDoc.exists ? (userDoc.data().fcmTokens || []) : [];

    if (!existing.includes(token)) {
      const updated = [...existing, token].slice(-10); // keep last 10
      await userRef.set({ fcmTokens: updated }, { merge: true });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving FCM token:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Notifications ────────────────────────────────────────────────────────────

app.get('/api/notifications', async (req, res) => {
  try {
    const snapshot = await db.collection('notifications')
      .where('userId', '==', req.uid)
      .get();
    const notifications = [];
    snapshot.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));
    notifications.sort((a, b) => (b.createdAt?._seconds ?? 0) - (a.createdAt?._seconds ?? 0));
    notifications.splice(30);
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/notifications/markRead', async (req, res) => {
  try {
    const snapshot = await db.collection('notifications')
      .where('userId', '==', req.uid)
      .where('read', '==', false)
      .get();
    const batch = db.batch();
    snapshot.forEach(doc => batch.update(doc.ref, { read: true }));
    await batch.commit();
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking notifications read:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Gatherings ───────────────────────────────────────────────────────────────

app.post('/api/gatherings', async (req, res) => {
  try {
    const { name, time, location, lat, lng, invitedUserIds } = req.body;
    const userId = req.uid;

    const creatorDoc = await db.collection('users').doc(userId).get();
    const creatorName = creatorDoc.exists ? (creatorDoc.data().name || 'Unknown') : 'Unknown';

    const invitedMembers = await Promise.all(
      (invitedUserIds || []).map(async uid => {
        const userDoc = await db.collection('users').doc(uid).get();
        return {
          uid,
          name: userDoc.exists ? (userDoc.data().name || 'Unknown') : 'Unknown',
          arrivedAt: null,
          isOnTime: null
        };
      })
    );

    const members = [
      { uid: userId, name: creatorName, arrivedAt: null, isOnTime: null },
      ...invitedMembers
    ];

    const gathering = {
      name, time, location,
      lat: lat ?? null, lng: lng ?? null,
      userId,
      memberIds: members.map(m => m.uid),
      createdAt: new Date(),
      members,
      autoLateProcessed: false,
    };

    const docRef = await db.collection('gatherings').add(gathering);

    await Promise.all(
      (invitedUserIds || []).map(uid =>
        createNotification(uid, 'gathering_invite', `${creatorName} invited you to "${name}"!`)
      )
    );

    res.json({ id: docRef.id, ...gathering });
  } catch (error) {
    console.error('Error creating gathering:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gatherings', async (req, res) => {
  try {
    const userId = req.uid;
    const [createdSnapshot, memberSnapshot] = await Promise.all([
      db.collection('gatherings').where('userId', '==', userId).get(),
      db.collection('gatherings').where('memberIds', 'array-contains', userId).get()
    ]);
    const gatheringMap = {};
    createdSnapshot.forEach(doc => { gatheringMap[doc.id] = { id: doc.id, ...doc.data() }; });
    memberSnapshot.forEach(doc => { gatheringMap[doc.id] = { id: doc.id, ...doc.data() }; });
    res.json(Object.values(gatheringMap));
  } catch (error) {
    console.error('Error fetching gatherings:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gatherings/:id', async (req, res) => {
  try {
    const doc = await db.collection('gatherings').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Gathering not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error('Error fetching gathering:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gatherings/:id/checkin', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const userId = req.uid;
    const gatheringRef = db.collection('gatherings').doc(req.params.id);
    const gatheringDoc = await gatheringRef.get();

    if (!gatheringDoc.exists) return res.status(404).json({ error: 'Gathering not found' });

    const gathering = gatheringDoc.data();
    const memberIndex = gathering.members.findIndex(m => m.uid === userId);

    if (memberIndex === -1) return res.status(403).json({ error: 'You are not a member of this gathering' });
    if (gathering.members[memberIndex].arrivedAt != null) return res.status(400).json({ error: 'You have already checked in' });

    const arrivedAt = new Date();
    const scheduledTime = new Date(gathering.time);
    const timeDiff = (arrivedAt - scheduledTime) / 1000 / 60;

    if (timeDiff < -60) {
      const minsUntil = Math.round(-timeDiff);
      const hoursUntil = Math.floor(minsUntil / 60);
      const label = hoursUntil > 0 ? `${hoursUntil}h ${minsUntil % 60}m` : `${minsUntil} minutes`;
      return res.status(400).json({ error: `This gathering starts in ${label} — check in opens 60 minutes before` });
    }

    const isOnTime = timeDiff <= 0;

    if (gathering.lat != null && gathering.lng != null) {
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Location access is required to check in to this gathering' });
      }
      const distance = haversineDistance(lat, lng, gathering.lat, gathering.lng);
      if (distance > 300) {
        return res.status(400).json({ error: `You're ${Math.round(distance)}m away — you need to be within 300m to check in` });
      }
    }

    gathering.members[memberIndex].arrivedAt = arrivedAt;
    gathering.members[memberIndex].isOnTime = isOnTime;
    await gatheringRef.update({ members: gathering.members });

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.exists ? userDoc.data() : {};

    const newStreak = isOnTime ? (userData.currentStreak || 0) + 1 : 0;
    const newPoints = isOnTime
      ? (userData.points || 0) + 10
      : Math.max(0, (userData.points || 0) - 5);
    const newLongest = Math.max(userData.longestStreak || 0, newStreak);

    await userRef.update({ points: newPoints, currentStreak: newStreak, longestStreak: newLongest });

    // Notify other checked-in members if this person is late
    if (!isOnTime) {
      const checkerName = gathering.members[memberIndex].name;
      const minutesLate = Math.round(timeDiff);
      for (const m of gathering.members) {
        if (m.uid !== userId && m.arrivedAt != null) {
          await createNotification(m.uid, 'late_arrival',
            `${checkerName} just checked in ${minutesLate}m late to "${gathering.name}"!`);
        }
      }
    }

    const pointsDelta = isOnTime ? 10 : -5;
    res.json({ ...gathering.members[memberIndex], points: newPoints, currentStreak: newStreak, pointsDelta });
  } catch (error) {
    console.error('Error checking in:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/gatherings/:id', async (req, res) => {
  try {
    const { name, time, location, lat, lng } = req.body;
    const userId = req.uid;
    const gatheringRef = db.collection('gatherings').doc(req.params.id);
    const gatheringDoc = await gatheringRef.get();

    if (!gatheringDoc.exists) return res.status(404).json({ error: 'Gathering not found' });
    if (gatheringDoc.data().userId !== userId) return res.status(403).json({ error: 'Only the creator can edit this gathering' });

    await gatheringRef.update({ name, time, location, lat: lat ?? null, lng: lng ?? null });
    res.json({ id: req.params.id, ...gatheringDoc.data(), name, time, location, lat, lng });
  } catch (error) {
    console.error('Error editing gathering:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gatherings/:id/invite', async (req, res) => {
  try {
    const { invitedUserIds } = req.body;
    const userId = req.uid;
    const gatheringRef = db.collection('gatherings').doc(req.params.id);
    const gatheringDoc = await gatheringRef.get();

    if (!gatheringDoc.exists) return res.status(404).json({ error: 'Gathering not found' });
    const gathering = gatheringDoc.data();
    if (gathering.userId !== userId) return res.status(403).json({ error: 'Only the creator can add members' });

    const existingUids = new Set(gathering.memberIds);
    const newUids = (invitedUserIds || []).filter(uid => !existingUids.has(uid));
    if (newUids.length === 0) return res.json({ id: req.params.id, ...gathering });

    const newMembers = await Promise.all(
      newUids.map(async uid => {
        const userDoc = await db.collection('users').doc(uid).get();
        return {
          uid,
          name: userDoc.exists ? (userDoc.data().name || 'Unknown') : 'Unknown',
          arrivedAt: null, isOnTime: null
        };
      })
    );

    const updatedMembers = [...gathering.members, ...newMembers];
    const updatedMemberIds = [...gathering.memberIds, ...newUids];
    await gatheringRef.update({ members: updatedMembers, memberIds: updatedMemberIds });

    const creatorDoc = await db.collection('users').doc(gathering.userId).get();
    const creatorName = creatorDoc.exists ? (creatorDoc.data().name || 'Someone') : 'Someone';
    await Promise.all(
      newUids.map(uid =>
        createNotification(uid, 'gathering_invite', `${creatorName} added you to "${gathering.name}"!`)
      )
    );

    res.json({ id: req.params.id, ...gathering, members: updatedMembers, memberIds: updatedMemberIds });
  } catch (error) {
    console.error('Error adding members:', error);
    res.status(500).json({ error: error.message });
  }
});

// Public gathering info — no auth, for invite link previews
app.get('/api/gatherings/:id/public', async (req, res) => {
  try {
    const doc = await db.collection('gatherings').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Gathering not found' });
    const g = doc.data();
    res.json({ id: doc.id, name: g.name, time: g.time, location: g.location, memberCount: (g.memberIds || []).length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Join via invite link — adds user to gathering if not already a member
app.post('/api/gatherings/:id/join', async (req, res) => {
  try {
    const userId = req.uid;
    const gatheringRef = db.collection('gatherings').doc(req.params.id);
    const gatheringDoc = await gatheringRef.get();
    if (!gatheringDoc.exists) return res.status(404).json({ error: 'Gathering not found' });
    const gathering = gatheringDoc.data();
    if ((gathering.memberIds || []).includes(userId)) return res.json({ success: true, alreadyMember: true });
    const userDoc = await db.collection('users').doc(userId).get();
    const name = userDoc.exists ? (userDoc.data().name || 'Unknown') : 'Unknown';
    await gatheringRef.update({
      members: [...(gathering.members || []), { uid: userId, name, arrivedAt: null, isOnTime: null }],
      memberIds: [...(gathering.memberIds || []), userId],
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gatherings/:id/leave', async (req, res) => {
  try {
    const userId = req.uid;
    const gatheringRef = db.collection('gatherings').doc(req.params.id);
    const gatheringDoc = await gatheringRef.get();

    if (!gatheringDoc.exists) return res.status(404).json({ error: 'Gathering not found' });
    const gathering = gatheringDoc.data();
    if (gathering.userId === userId) return res.status(400).json({ error: 'Creator cannot leave — delete the gathering instead' });

    await gatheringRef.update({
      members: gathering.members.filter(m => m.uid !== userId),
      memberIds: gathering.memberIds.filter(uid => uid !== userId)
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error leaving gathering:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/gatherings/:id', async (req, res) => {
  try {
    const userId = req.uid;
    const gatheringRef = db.collection('gatherings').doc(req.params.id);
    const gatheringDoc = await gatheringRef.get();

    if (!gatheringDoc.exists) return res.status(404).json({ error: 'Gathering not found' });
    if (gatheringDoc.data().userId !== userId) return res.status(403).json({ error: 'Only the creator can delete this gathering' });

    await gatheringRef.delete();
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting gathering:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Leaderboard ──────────────────────────────────────────────────────────────

app.get('/api/leaderboard', async (req, res) => {
  try {
    const userId = req.uid;
    const friendsSnapshot = await db.collection('friends')
      .where('users', 'array-contains', userId)
      .get();

    const friendUids = [];
    friendsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.status === 'accepted') friendUids.push(data.users.find(uid => uid !== userId));
    });

    const allUids = [userId, ...friendUids];
    const profiles = {};
    await Promise.all(allUids.map(async uid => {
      const doc = await db.collection('users').doc(uid).get();
      if (doc.exists) profiles[uid] = doc.data();
    }));

    const stats = await Promise.all(allUids.map(async uid => {
      const snapshot = await db.collection('gatherings')
        .where('memberIds', 'array-contains', uid)
        .get();

      let attended = 0, onTime = 0, late = 0, totalMinuteOffset = 0;
      const checkInRecords = [];
      snapshot.forEach(doc => {
        const member = doc.data().members?.find(m => m.uid === uid);
        if (member?.arrivedAt != null) {
          attended++;
          if (member.isOnTime) onTime++; else late++;
          const arrivedMs = member.arrivedAt._seconds
            ? member.arrivedAt._seconds * 1000
            : new Date(member.arrivedAt).getTime();
          totalMinuteOffset += (arrivedMs - new Date(doc.data().time).getTime()) / 1000 / 60;
          checkInRecords.push({ time: new Date(doc.data().time), isOnTime: member.isOnTime });
        }
      });

      // Compute streaks from actual check-in history (not the stored counter, which can drift)
      checkInRecords.sort((a, b) => a.time - b.time); // ascending
      let longestStreak = 0, run = 0;
      for (const r of checkInRecords) {
        run = r.isOnTime ? run + 1 : 0;
        if (run > longestStreak) longestStreak = run;
      }
      let currentStreak = 0;
      for (let i = checkInRecords.length - 1; i >= 0; i--) {
        if (checkInRecords[i].isOnTime) currentStreak++;
        else break;
      }

      const profile = profiles[uid] || {};
      return {
        uid,
        name: profile.name || 'Unknown',
        username: profile.username || '',
        photoUrl: profile.photoUrl || null,
        attended, onTime, late,
        punctualityRate: attended > 0 ? Math.round((onTime / attended) * 100) : null,
        avgMinutes: attended > 0 ? Math.round(totalMinuteOffset / attended) : null,
        points: profile.points || 0,
        currentStreak,
        longestStreak,
        isYou: uid === userId
      };
    }));

    stats.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (a.punctualityRate === null && b.punctualityRate === null) return 0;
      if (a.punctualityRate === null) return 1;
      if (b.punctualityRate === null) return -1;
      return b.punctualityRate - a.punctualityRate;
    });

    res.json(stats);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Users ────────────────────────────────────────────────────────────────────
// NOTE: /api/users/search and /api/users/profile must come before /api/users/:uid/*

app.get('/api/users/search', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username is required' });

    const snapshot = await db.collection('users')
      .where('username', '==', username.trim())
      .get();

    const users = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.uid !== req.uid) {
        users.push({ uid: data.uid, name: data.name, username: data.username });
      }
    });
    res.json(users);
  } catch (error) {
    console.error('Error searching users:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save profile — enforces username uniqueness
app.put('/api/users/profile', async (req, res) => {
  try {
    const { name, username, email, phone } = req.body;
    const userId = req.uid;
    if (!name?.trim() || !username?.trim()) {
      return res.status(400).json({ error: 'Name and username are required' });
    }

    // Check username uniqueness (case-sensitive exact match)
    const existing = await db.collection('users')
      .where('username', '==', username.trim())
      .get();
    for (const doc of existing.docs) {
      if (doc.id !== userId) {
        return res.status(400).json({ error: 'Username already taken' });
      }
    }

    await db.collection('users').doc(userId).set({
      name: name.trim(),
      username: username.trim(),
      uid: userId,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {})
    }, { merge: true });

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving profile:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users/find-by-phones', async (req, res) => {
  try {
    const { phones } = req.body;
    if (!Array.isArray(phones) || phones.length === 0) return res.json([]);
    const results = [];
    const chunks = [];
    for (let i = 0; i < phones.length; i += 10) chunks.push(phones.slice(i, i + 10));
    for (const chunk of chunks) {
      const snap = await db.collection('users').where('phone', 'in', chunk).get();
      snap.forEach(doc => {
        const d = doc.data();
        if (d.uid !== req.uid) results.push({ uid: d.uid, name: d.name, username: d.username, phone: d.phone });
      });
    }
    res.json(results);
  } catch (error) {
    console.error('Error finding by phones:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/:uid/checkins', async (req, res) => {
  try {
    const { uid } = req.params;
    const snapshot = await db.collection('gatherings')
      .where('memberIds', 'array-contains', uid)
      .get();

    const checkins = [];
    snapshot.forEach(doc => {
      const g = doc.data();
      const member = g.members?.find(m => m.uid === uid);
      if (member?.arrivedAt != null) {
        const arrivedMs = member.arrivedAt._seconds
          ? member.arrivedAt._seconds * 1000
          : new Date(member.arrivedAt).getTime();
        const scheduledMs = new Date(g.time).getTime();
        checkins.push({
          gatheringName: g.name,
          time: new Date(scheduledMs).toISOString(),
          arrivedAt: new Date(arrivedMs).toISOString(),
          isOnTime: member.isOnTime,
          minutesDiff: Math.round((arrivedMs - scheduledMs) / 1000 / 60),
        });
      }
    });
    checkins.sort((a, b) => new Date(a.time) - new Date(b.time));
    res.json(checkins);
  } catch (error) {
    console.error('Error fetching checkins:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/:uid/stats', async (req, res) => {
  try {
    const { uid } = req.params;
    const [userDoc, snapshot] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('gatherings').where('memberIds', 'array-contains', uid).get()
    ]);
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const profile = userDoc.data();
    let attended = 0, onTime = 0, late = 0, totalMinuteOffset = 0;
    const checkInRecords = [];
    snapshot.forEach(doc => {
      const member = doc.data().members?.find(m => m.uid === uid);
      if (member?.arrivedAt != null) {
        attended++;
        if (member.isOnTime) onTime++; else late++;
        const arrivedMs = member.arrivedAt._seconds
          ? member.arrivedAt._seconds * 1000
          : new Date(member.arrivedAt).getTime();
        totalMinuteOffset += (arrivedMs - new Date(doc.data().time).getTime()) / 1000 / 60;
        checkInRecords.push({ time: new Date(doc.data().time), isOnTime: member.isOnTime });
      }
    });
    checkInRecords.sort((a, b) => a.time - b.time);
    let longestStreak = 0, run = 0;
    for (const r of checkInRecords) {
      run = r.isOnTime ? run + 1 : 0;
      if (run > longestStreak) longestStreak = run;
    }
    let currentStreak = 0;
    for (let i = checkInRecords.length - 1; i >= 0; i--) {
      if (checkInRecords[i].isOnTime) currentStreak++;
      else break;
    }
    res.json({
      uid,
      name: profile.name || 'Unknown',
      username: profile.username || '',
      photoUrl: profile.photoUrl || null,
      points: profile.points || 0,
      currentStreak,
      longestStreak,
      attended, onTime, late,
      punctualityRate: attended > 0 ? Math.round((onTime / attended) * 100) : null,
      avgMinutes: attended > 0 ? Math.round(totalMinuteOffset / attended) : null,
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Friends ──────────────────────────────────────────────────────────────────

app.post('/api/friends/request', async (req, res) => {
  try {
    const { toUserId } = req.body;
    const fromUserId = req.uid;
    if (!toUserId) return res.status(400).json({ error: 'toUserId is required' });
    if (toUserId === fromUserId) return res.status(400).json({ error: 'Cannot send a friend request to yourself' });

    // Check for existing request or friendship
    const existing = await db.collection('friends')
      .where('users', 'array-contains', fromUserId)
      .get();
    for (const doc of existing.docs) {
      if (doc.data().users.includes(toUserId)) {
        return res.status(400).json({ error: 'Friend request already sent or already friends' });
      }
    }

    const docRef = await db.collection('friends').add({
      users: [fromUserId, toUserId],
      fromUserId, toUserId,
      status: 'pending',
      createdAt: new Date()
    });

    // Notify recipient
    const fromDoc = await db.collection('users').doc(fromUserId).get();
    const fromName = fromDoc.exists ? (fromDoc.data().name || 'Someone') : 'Someone';
    await createNotification(toUserId, 'friend_request', `${fromName} sent you a friend request!`);

    res.json({ id: docRef.id });
  } catch (error) {
    console.error('Error sending friend request:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/friends/accept', async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId is required' });

    const docRef = db.collection('friends').doc(requestId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Friend request not found' });

    const data = doc.data();
    if (data.toUserId !== req.uid) return res.status(403).json({ error: 'Only the recipient can accept this request' });
    if (data.status === 'accepted') return res.status(400).json({ error: 'Already friends' });

    await docRef.update({ status: 'accepted' });

    const acceptorDoc = await db.collection('users').doc(data.toUserId).get();
    const acceptorName = acceptorDoc.exists ? (acceptorDoc.data().name || 'Someone') : 'Someone';
    await createNotification(data.fromUserId, 'friend_accepted', `${acceptorName} accepted your friend request!`);

    res.json({ success: true });
  } catch (error) {
    console.error('Error accepting friend request:', error);
    res.status(500).json({ error: error.message });
  }
});

// Decline a pending request OR unfriend — caller must be one of the two users
app.delete('/api/friends/:requestId', async (req, res) => {
  try {
    const docRef = db.collection('friends').doc(req.params.requestId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (!doc.data().users.includes(req.uid)) return res.status(403).json({ error: 'Forbidden' });
    await docRef.delete();
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing friend:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/friends', async (req, res) => {
  try {
    const userId = req.uid;
    const snapshot = await db.collection('friends')
      .where('users', 'array-contains', userId)
      .get();

    const friends = [], pendingReceived = [], pendingSent = [];
    const uidsToFetch = new Set();
    snapshot.forEach(doc => {
      const otherUid = doc.data().users.find(uid => uid !== userId);
      uidsToFetch.add(otherUid);
    });

    const userProfiles = {};
    await Promise.all([...uidsToFetch].map(async uid => {
      const userDoc = await db.collection('users').doc(uid).get();
      if (userDoc.exists) userProfiles[uid] = userDoc.data();
    }));

    snapshot.forEach(doc => {
      const data = doc.data();
      const otherUid = data.users.find(uid => uid !== userId);
      const profile = userProfiles[otherUid] || { name: 'Unknown', username: 'unknown' };
      const entry = {
        requestId: doc.id, uid: otherUid,
        name: profile.name, username: profile.username,
        photoUrl: profile.photoUrl || null,
        status: data.status
      };
      if (data.status === 'accepted') friends.push(entry);
      else if (data.status === 'pending') {
        if (data.toUserId === userId) pendingReceived.push(entry);
        else pendingSent.push(entry);
      }
    });

    res.json({ friends, pendingReceived, pendingSent });
  } catch (error) {
    console.error('Error fetching friends:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Activity feed ─────────────────────────────────────────────────────────────

app.get('/api/activity', async (req, res) => {
  try {
    const userId = req.uid;
    // Get friend UIDs
    const friendsSnap = await db.collection('friends')
      .where('users', 'array-contains', userId)
      .where('status', '==', 'accepted')
      .get();
    const friendUids = [];
    friendsSnap.forEach(doc => {
      friendUids.push(doc.data().users.find(u => u !== userId));
    });
    const allUids = new Set([userId, ...friendUids]);

    // Fetch recent gatherings for the group
    const gatheringsSnap = await db.collection('gatherings')
      .where('memberIds', 'array-contains', userId)
      .get();

    // Build profile map
    const profileMap = {};
    await Promise.all([...allUids].map(async uid => {
      const d = await db.collection('users').doc(uid).get();
      if (d.exists) profileMap[uid] = d.data();
    }));

    const events = [];
    gatheringsSnap.forEach(doc => {
      const g = doc.data();
      (g.members || []).forEach(m => {
        if (m.arrivedAt != null && allUids.has(m.uid)) {
          const arrivedMs = m.arrivedAt._seconds
            ? m.arrivedAt._seconds * 1000
            : new Date(m.arrivedAt).getTime();
          events.push({
            uid: m.uid,
            name: profileMap[m.uid]?.name || m.name || 'Unknown',
            photoUrl: profileMap[m.uid]?.photoUrl || null,
            gatheringId: doc.id,
            gatheringName: g.name,
            isOnTime: m.isOnTime,
            autoLate: m.autoLate || false,
            arrivedAt: new Date(arrivedMs).toISOString(),
            scheduledTime: g.time,
            isYou: m.uid === userId,
          });
        }
      });
    });

    events.sort((a, b) => new Date(b.arrivedAt) - new Date(a.arrivedAt));
    res.json(events.slice(0, 30));
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Weekly challenges ──────────────────────────────────────────────────────────

function getWeekBounds() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return { start: monday, end: nextMonday };
}

app.get('/api/challenges', async (req, res) => {
  try {
    const userId = req.uid;
    const { start, end } = getWeekBounds();

    // Fetch all gatherings this user was in
    const snap = await db.collection('gatherings')
      .where('memberIds', 'array-contains', userId)
      .get();

    let weekOnTime = 0, weekAttended = 0;
    snap.forEach(doc => {
      const g = doc.data();
      const gTime = new Date(g.time);
      if (gTime < start || gTime >= end) return;
      const member = g.members?.find(m => m.uid === userId);
      if (member?.arrivedAt != null) {
        weekAttended++;
        if (member.isOnTime) weekOnTime++;
      }
    });

    // Compute current streak from leaderboard logic (reuse check-in records)
    const allCheckIns = [];
    snap.forEach(doc => {
      const g = doc.data();
      const member = g.members?.find(m => m.uid === userId);
      if (member?.arrivedAt != null) {
        allCheckIns.push({ time: new Date(g.time), isOnTime: member.isOnTime });
      }
    });
    allCheckIns.sort((a, b) => a.time - b.time);
    let currentStreak = 0;
    for (let i = allCheckIns.length - 1; i >= 0; i--) {
      if (allCheckIns[i].isOnTime) currentStreak++;
      else break;
    }

    const challenges = [
      {
        id: 'on_time_3',
        title: 'Run Back the Clock',
        desc: 'Check in on time 3× this week',
        progress: Math.min(weekOnTime, 3),
        goal: 3,
        reward: 25,
        done: weekOnTime >= 3,
      },
      {
        id: 'attend_2',
        title: 'Quit Fading',
        desc: 'Attend 2 gatherings this week',
        progress: Math.min(weekAttended, 2),
        goal: 2,
        reward: 15,
        done: weekAttended >= 2,
      },
      {
        id: 'streak_3',
        title: 'Hot Streak',
        desc: 'Maintain a streak of 3 gatherings or more',
        progress: Math.min(currentStreak, 3),
        goal: 3,
        reward: 20,
        done: currentStreak >= 3,
      },
    ];

    // Award bonus points for newly completed challenges (idempotent via Firestore doc)
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.data() || {};
    const weekKey = `challenges_${start.toISOString().slice(0, 10)}`;
    const awarded = userData[weekKey] || [];
    const newlyAwarded = [];

    for (const c of challenges) {
      if (c.done && !awarded.includes(c.id)) {
        newlyAwarded.push(c.id);
      }
    }
    if (newlyAwarded.length > 0) {
      const bonusPoints = newlyAwarded.reduce((sum, id) => {
        const c = challenges.find(ch => ch.id === id);
        return sum + (c?.reward || 0);
      }, 0);
      await userRef.set({
        points: (userData.points || 0) + bonusPoints,
        [weekKey]: [...awarded, ...newlyAwarded],
      }, { merge: true });
    }

    res.json({ challenges, weekStart: start.toISOString(), awarded: [...awarded, ...newlyAwarded] });
  } catch (error) {
    console.error('Error fetching challenges:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Auto-late job ──────────────────────────────────────────────────────────────

async function processAutoLate() {
  try {
    const GRACE_MINUTES = 15;
    const now = Date.now();
    const cutoff = new Date(now - GRACE_MINUTES * 60 * 1000);    // must be at least 15 min ago
    const lookback = new Date(now - 48 * 60 * 60 * 1000);        // don't re-process old gatherings

    // Query gatherings in the processing window by time string range
    // We store time as ISO string so we compare lexicographically — works for ISO dates
    const snap = await db.collection('gatherings')
      .where('time', '>', lookback.toISOString())
      .where('time', '<', cutoff.toISOString())
      .get();

    const notifications = [];
    let processedCount = 0;

    for (const doc of snap.docs) {
      const g = doc.data();
      if (g.autoLateProcessed) continue; // already handled

      const unChecked = (g.members || []).filter(m => m.arrivedAt == null);
      if (unChecked.length === 0) {
        await doc.ref.update({ autoLateProcessed: true });
        continue;
      }

      const updatedMembers = (g.members || []).map(m => {
        if (m.arrivedAt != null) return m;
        notifications.push({ uid: m.uid, gatheringName: g.name, memberName: m.name, allMembers: g.members });
        return { ...m, arrivedAt: g.time, isOnTime: false, autoLate: true };
      });

      await doc.ref.update({ members: updatedMembers, autoLateProcessed: true });
      processedCount++;
    }

    // Update user stats and send notifications
    for (const { uid, gatheringName, memberName, allMembers } of notifications) {
      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        await userRef.update({
          points: Math.max(0, (userData.points || 0) - 5),
          currentStreak: 0,
        });
      }
      // Notify checked-in members about the no-show
      for (const other of allMembers) {
        if (other.uid !== uid && other.arrivedAt != null) {
          await createNotification(other.uid, 'auto_late',
            `${memberName} didn't show up to "${gatheringName}" and was marked late!`);
        }
      }
    }

    if (processedCount > 0) console.log(`Auto-late: marked ${notifications.length} member(s) across ${processedCount} gathering(s)`);
  } catch (err) {
    console.error('Auto-late job error:', err);
  }
}

// Run auto-late check every 5 minutes
setInterval(processAutoLate, 5 * 60 * 1000);
// Also run once on startup (after a short delay to let server initialize)
setTimeout(processAutoLate, 10000);

// ── Gathering reminder notifications ──────────────────────────────────────────

async function sendGatheringReminders() {
  try {
    const now = Date.now();
    const reminders = [
      {
        label: '60min',
        fromMs: now + 58 * 60 * 1000,
        toMs:   now + 62 * 60 * 1000,
        title: 'Gathering soon',
        body:  name => `"${name}" starts in about 1 hour — check-in opens soon!`,
      },
      {
        label: '10min',
        fromMs: now + 8  * 60 * 1000,
        toMs:   now + 12 * 60 * 1000,
        title: 'Time to check in!',
        body:  name => `"${name}" starts in ~10 minutes. Open the app to check in.`,
      },
    ];

    for (const reminder of reminders) {
      const from = new Date(reminder.fromMs).toISOString();
      const to   = new Date(reminder.toMs).toISOString();

      const snap = await db.collection('gatherings')
        .where('time', '>=', from)
        .where('time', '<=', to)
        .get();

      for (const doc of snap.docs) {
        const g = doc.data();
        const sent = g.remindersSent || [];
        if (sent.includes(reminder.label)) continue; // already sent this reminder

        // Mark as sent immediately to prevent duplicate sends
        await doc.ref.update({ remindersSent: [...sent, reminder.label] });

        // Collect FCM tokens for all members
        const tokens = [];
        for (const uid of (g.memberIds || [])) {
          const userDoc = await db.collection('users').doc(uid).get();
          if (userDoc.exists) {
            const userTokens = userDoc.data().fcmTokens || [];
            tokens.push(...userTokens);
          }
        }
        if (tokens.length === 0) continue;

        // Send via FCM
        const result = await admin.messaging().sendEachForMulticast({
          tokens,
          notification: { title: reminder.title, body: reminder.body(g.name) },
          webpush: { fcmOptions: { link: '/' } },
        });
        console.log(`Reminder [${reminder.label}] "${g.name}": ${result.successCount} sent, ${result.failureCount} failed`);

        // Remove stale tokens (expired/unregistered)
        const staleTokens = [];
        result.responses.forEach((r, i) => {
          if (!r.success && (
            r.error?.code === 'messaging/registration-token-not-registered' ||
            r.error?.code === 'messaging/invalid-registration-token'
          )) {
            staleTokens.push(tokens[i]);
          }
        });
        if (staleTokens.length > 0) {
          // Remove stale tokens from each affected user
          for (const uid of (g.memberIds || [])) {
            const userDoc = await db.collection('users').doc(uid).get();
            if (!userDoc.exists) continue;
            const current = userDoc.data().fcmTokens || [];
            const cleaned = current.filter(t => !staleTokens.includes(t));
            if (cleaned.length !== current.length) {
              await db.collection('users').doc(uid).update({ fcmTokens: cleaned });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Reminder job error:', err);
  }
}

// Run every minute
setInterval(sendGatheringReminders, 60 * 1000);
setTimeout(sendGatheringReminders, 15000);

// ── Static file serving (production only) ────────────────────────────────────
// Must come AFTER all /api routes so API paths are never swallowed.
if (process.env.NODE_ENV === 'production') {
  const path = require('path');
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
