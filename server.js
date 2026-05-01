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
app.set('trust proxy', 1);

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

// Web join page — served to people who don't have the app yet
app.get('/join/:id', async (req, res) => {
  try {
    const doc = await db.collection('gatherings').doc(req.params.id).get();
    const g = doc.exists ? doc.data() : null;
    const name = g ? g.name : 'A Gathering';
    const time = g ? new Date(g.time).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    const location = g?.location || '';
    const count = g ? (g.memberIds || []).length : 0;
    const deepLink = `clocked://join/${req.params.id}`;
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} · Clocked</title><meta http-equiv="refresh" content="0;url=${deepLink}"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#0c0c0c;border-radius:28px;padding:40px 32px;max-width:360px;width:100%;text-align:center}.pill{background:rgba(124,58,237,.15);color:#a78bfa;font-size:12px;font-weight:700;padding:6px 14px;border-radius:99px;display:inline-block;margin-bottom:20px}.title{font-size:28px;font-weight:800;letter-spacing:-.8px;margin-bottom:8px}.meta{color:rgba(255,255,255,.45);font-size:14px;margin-bottom:4px}.btn{display:block;background:#7c3aed;color:#fff;font-size:16px;font-weight:700;padding:16px;border-radius:16px;text-decoration:none;margin-top:28px}p{color:rgba(255,255,255,.3);font-size:12px;margin-top:16px}</style></head><body><div class="card"><div class="pill">You're invited</div><div class="title">${name}</div>${time ? `<div class="meta">${time}</div>` : ''}${location ? `<div class="meta">${location}</div>` : ''}<div class="meta" style="margin-top:8px">${count} going</div><a class="btn" href="${deepLink}">Open in Clocked</a><p>Don't have the app? Search "Clocked" in the App Store.</p></div></body></html>`);
  } catch {
    res.redirect(`clocked://join/${req.params.id}`);
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

// Send via Expo's push service — handles both ExponentPushToken and raw device tokens
async function sendExpoPushToUids(uids, title, body) {
  if (!uids.length) return;
  const expoTokens = [];
  const apnsTokens = [];
  for (const uid of uids) {
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) continue;
    for (const t of (doc.data().expoPushTokens || [])) {
      if (typeof t === 'string' && t.startsWith('ExponentPushToken[')) {
        expoTokens.push(t);
      } else if (typeof t === 'string' && t.length > 0) {
        apnsTokens.push(t); // raw APNs/FCM device token
      }
    }
  }
  // Send Expo push tokens via Expo's API
  if (expoTokens.length) {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(expoTokens.map(to => ({ to, title, body, sound: 'default' }))),
      });
      const result = await res.json();
      const errors = (result.data || []).filter(r => r.status === 'error');
      if (errors.length) console.warn('Expo push errors:', JSON.stringify(errors));
    } catch (e) {
      console.error('Expo push failed:', e.message);
    }
  }
  // Raw device tokens go through FCM (handles both APNs and Android)
  if (apnsTokens.length) {
    try {
      await admin.messaging().sendEachForMulticast({
        tokens: apnsTokens,
        notification: { title, body },
        apns: { payload: { aps: { sound: 'default' } } },
      });
    } catch (e) {
      console.error('FCM device token push failed:', e.message);
    }
  }
}

// Legacy FCM path — kept for future Android / standalone builds
async function sendFcmToUids(uids, title, body) {
  if (!uids.length) return;
  const tokens = [];
  const tokenToUid = {};
  for (const uid of uids) {
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) continue;
    for (const t of (doc.data().fcmTokens || [])) {
      tokens.push(t);
      tokenToUid[t] = uid;
    }
  }
  if (!tokens.length) return;
  const result = await admin.messaging().sendEachForMulticast({ tokens, notification: { title, body } });
  const stale = result.responses
    .map((r, i) => (!r.success &&
      (r.error?.code === 'messaging/registration-token-not-registered' ||
       r.error?.code === 'messaging/invalid-registration-token')) ? tokens[i] : null)
    .filter(Boolean);
  if (stale.length) {
    const staleByUid = {};
    for (const t of stale) {
      const uid = tokenToUid[t];
      if (uid) (staleByUid[uid] = staleByUid[uid] || []).push(t);
    }
    for (const [uid, bad] of Object.entries(staleByUid)) {
      const doc = await db.collection('users').doc(uid).get();
      if (!doc.exists) continue;
      const cleaned = (doc.data().fcmTokens || []).filter(t => !bad.includes(t));
      await db.collection('users').doc(uid).update({ fcmTokens: cleaned });
    }
  }
}

// Send to all registered push channels for a set of UIDs
async function sendPushToUids(uids, title, body) {
  await Promise.all([
    sendExpoPushToUids(uids, title, body),
    sendFcmToUids(uids, title, body),
  ]);
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

// Store Expo push token (used by Expo Go and Expo-built apps)
app.post('/api/users/expo-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });
    const userRef = db.collection('users').doc(req.uid);
    const userDoc = await userRef.get();
    const existing = userDoc.exists ? (userDoc.data().expoPushTokens || []) : [];
    if (!existing.includes(token)) {
      await userRef.set({ expoPushTokens: [...existing, token].slice(-10) }, { merge: true });
    }
    res.json({ success: true });
  } catch (error) {
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

    if (!invitedUserIds || invitedUserIds.length === 0) {
      return res.status(400).json({ error: 'Invite at least one friend — gatherings need more than one person.' });
    }

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
    const isEarly = timeDiff <= -5; // 5+ minutes early = early bird bonus

    // Points: +12 early, +10 on time, proportional negative for late
    const lateMinutes = Math.max(0, Math.round(timeDiff));
    let pointsDelta;
    if (isEarly) {
      pointsDelta = 12;
    } else if (isOnTime) {
      pointsDelta = 10;
    } else {
      pointsDelta = -Math.min(10, Math.max(1, Math.round(lateMinutes / 6)));
    }

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
    const newPoints = (userData.points || 0) + pointsDelta;
    const newLongest = Math.max(userData.longestStreak || 0, newStreak);

    await userRef.update({ points: newPoints, currentStreak: newStreak, longestStreak: newLongest });

    if (!isOnTime) {
      const checkerName = gathering.members[memberIndex].name;
      const otherUids = gathering.members.filter(m => m.uid !== userId).map(m => m.uid);
      await Promise.all(otherUids.map(uid =>
        createNotification(uid, 'late_arrival',
          `${checkerName} checked in ${lateMinutes}m late to "${gathering.name}"`)
      ));
      await sendPushToUids(
        otherUids,
        `Late check-in`,
        `${checkerName} just checked in ${lateMinutes}m late to "${gathering.name}"`
      );
    }

    res.json({ ...gathering.members[memberIndex], points: newPoints, currentStreak: newStreak, pointsDelta, lateMinutes, earlyBonus: isEarly });
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

    const existing = gatheringDoc.data();
    const timeChanged = existing.time !== time;
    await gatheringRef.update({
      name, time, location, lat: lat ?? null, lng: lng ?? null,
      ...(timeChanged && { remindersSent: [] }),
    });
    const updated = await gatheringRef.get();
    res.json({ id: req.params.id, ...updated.data() });
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

// ── Live location sharing ─────────────────────────────────────────────────────

// Store current location for live tracking (during the hour before a gathering)
app.post('/api/gatherings/:id/location', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng are required numbers' });
    }
    const gatheringRef = db.collection('gatherings').doc(req.params.id);
    const doc = await gatheringRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Gathering not found' });
    if (!(doc.data().memberIds || []).includes(req.uid)) {
      return res.status(403).json({ error: 'Not a member of this gathering' });
    }
    await gatheringRef.update({
      [`liveLocations.${req.uid}`]: { lat, lng, updatedAt: new Date().toISOString() }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all member live locations for a gathering
app.get('/api/gatherings/:id/locations', async (req, res) => {
  try {
    const doc = await db.collection('gatherings').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Gathering not found' });
    if (!(doc.data().memberIds || []).includes(req.uid)) {
      return res.status(403).json({ error: 'Not a member of this gathering' });
    }
    res.json(doc.data().liveLocations || {});
  } catch (error) {
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

// ── Reactions ─────────────────────────────────────────────────────────────────

app.post('/api/gatherings/:id/react', async (req, res) => {
  try {
    const { emoji } = req.body;
    const ALLOWED = ['👍', '🔥', '💀', '😂', '👏'];
    if (!ALLOWED.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction' });
    const ref = db.collection('gatherings').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const reactions = doc.data().reactions || {};
    if (!reactions[emoji]) reactions[emoji] = [];
    if (reactions[emoji].includes(req.uid)) {
      reactions[emoji] = reactions[emoji].filter(u => u !== req.uid);
    } else {
      reactions[emoji].push(req.uid);
    }
    await ref.update({ reactions });
    res.json({ reactions });
  } catch (error) {
    console.error('Error reacting:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Nudge ─────────────────────────────────────────────────────────────────────

// Send a quick preset message as a push notification to another gathering member
app.post('/api/gatherings/:id/nudge', async (req, res) => {
  try {
    const { targetUid, message } = req.body;
    if (!targetUid || !message) return res.status(400).json({ error: 'targetUid and message required' });
    const doc = await db.collection('gatherings').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Gathering not found' });
    const g = doc.data();
    if (!(g.memberIds || []).includes(req.uid)) return res.status(403).json({ error: 'Not a member' });
    if (!(g.memberIds || []).includes(targetUid)) return res.status(400).json({ error: 'Target is not a member' });
    const senderDoc = await db.collection('users').doc(req.uid).get();
    const senderName = senderDoc.exists ? (senderDoc.data().name || 'Someone') : 'Someone';
    await createNotification(targetUid, 'nudge', `${senderName}: ${message}`);
    await sendPushToUids([targetUid], `${senderName} nudged you`, message);
    res.json({ success: true });
  } catch (error) {
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

    const shieldKey = `shield_${start.toISOString().slice(0, 10)}`;
    const streakShieldAvailable = !userData[shieldKey];
    res.json({ challenges, weekStart: start.toISOString(), awarded: [...awarded, ...newlyAwarded], streakShieldAvailable });
  } catch (error) {
    console.error('Error fetching challenges:', error);
    res.status(500).json({ error: error.message });
  }
});

// Weekly leaderboard — stats for the current Mon–Sun window only
app.get('/api/leaderboard/weekly', async (req, res) => {
  try {
    const userId = req.uid;
    const { start, end } = getWeekBounds();

    const friendsSnap = await db.collection('friends').where('users', 'array-contains', userId).get();
    const friendUids = [userId];
    friendsSnap.forEach(doc => {
      if (doc.data().status === 'accepted')
        friendUids.push(doc.data().users.find(u => u !== userId));
    });

    const [gatheringsSnap, ...profileDocs] = await Promise.all([
      db.collection('gatherings').where('time', '>=', start.toISOString()).where('time', '<', end.toISOString()).get(),
      ...friendUids.map(uid => db.collection('users').doc(uid).get()),
    ]);

    const profiles = {};
    profileDocs.forEach(doc => { if (doc.exists) profiles[doc.id] = doc.data(); });

    const stats = friendUids.map(uid => {
      let onTime = 0, late = 0, weeklyPoints = 0;
      gatheringsSnap.forEach(doc => {
        const g = doc.data();
        if (!(g.memberIds || []).includes(uid)) return;
        const m = (g.members || []).find(m => m.uid === uid);
        if (!m || m.arrivedAt == null) return;
        if (m.isOnTime) {
          onTime++;
          weeklyPoints += 10;
        } else {
          late++;
          const arrivedMs = m.arrivedAt._seconds ? m.arrivedAt._seconds * 1000 : new Date(m.arrivedAt).getTime();
          const minsLate = Math.max(0, Math.round((arrivedMs - new Date(g.time).getTime()) / 60000));
          weeklyPoints -= Math.min(10, Math.max(1, Math.round(minsLate / 6)));
        }
      });
      const p = profiles[uid] || {};
      const attended = onTime + late;
      return {
        uid, name: p.name || 'Unknown', username: p.username || '', photoUrl: p.photoUrl || null,
        onTime, late, attended, weeklyPoints,
        punctualityRate: attended > 0 ? Math.round((onTime / attended) * 100) : null,
        currentStreak: p.currentStreak || 0,
        isYou: uid === userId,
      };
    });

    stats.sort((a, b) => {
      if (b.weeklyPoints !== a.weeklyPoints) return b.weeklyPoints - a.weeklyPoints;
      if (a.punctualityRate === null) return 1;
      if (b.punctualityRate === null) return -1;
      return b.punctualityRate - a.punctualityRate;
    });

    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Friends' challenge completion for the current week
app.get('/api/challenges/friends', async (req, res) => {
  try {
    const userId = req.uid;
    const { start } = getWeekBounds();
    const weekKey = `challenges_${start.toISOString().slice(0, 10)}`;

    const friendsSnap = await db.collection('friends')
      .where('users', 'array-contains', userId)
      .get();

    const uids = [userId];
    friendsSnap.forEach(doc => {
      if (doc.data().status === 'accepted')
        uids.push(doc.data().users.find(u => u !== userId));
    });

    const results = await Promise.all(uids.map(async uid => {
      const doc = await db.collection('users').doc(uid).get();
      if (!doc.exists) return null;
      const d = doc.data();
      return { uid, name: d.name || 'Unknown', photoUrl: d.photoUrl || null, completed: (d[weekKey] || []).length, isYou: uid === userId };
    }));

    res.json(results.filter(Boolean).sort((a, b) => b.completed - a.completed));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Auto-late job ──────────────────────────────────────────────────────────────

async function processAutoLate() {
  try {
    const GRACE_MINUTES = 60;
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
    const { start: weekStart } = getWeekBounds();
    const shieldKey = `shield_${weekStart.toISOString().slice(0, 10)}`;

    for (const { uid, gatheringName, memberName, allMembers } of notifications) {
      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        const shieldAvailable = !userData[shieldKey] && (userData.currentStreak || 0) > 0;
        if (shieldAvailable) {
          // Shield absorbs the no-show — streak survives, points still deducted
          await userRef.update({ points: (userData.points || 0) - 10, [shieldKey]: true });
          await sendPushToUids([uid], 'Streak shield activated', `Your ${userData.currentStreak}-streak was protected from "${gatheringName}". Shield used for this week.`);
        } else {
          await userRef.update({ points: (userData.points || 0) - 10, currentStreak: 0 });
        }
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

    // ── Standard reminders (broadcast to all members) ─────────────────────────
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
      const snap = await db.collection('gatherings').where('time', '>=', from).where('time', '<=', to).get();

      for (const doc of snap.docs) {
        const g = doc.data();
        const sent = g.remindersSent || [];
        if (sent.includes(reminder.label)) continue;
        await doc.ref.update({ remindersSent: [...sent, reminder.label] });
        await sendPushToUids(g.memberIds || [], reminder.title, reminder.body(g.name));
        console.log(`Reminder [${reminder.label}] sent for "${g.name}"`);
      }
    }

    // ── Streak-risk reminder (30 min before, only members with active streaks) ──
    const streakFrom = new Date(now + 28 * 60 * 1000).toISOString();
    const streakTo   = new Date(now + 32 * 60 * 1000).toISOString();
    const streakSnap = await db.collection('gatherings').where('time', '>=', streakFrom).where('time', '<=', streakTo).get();

    for (const doc of streakSnap.docs) {
      const g = doc.data();
      const sent = g.remindersSent || [];
      if (sent.includes('streak-risk')) continue;
      await doc.ref.update({ remindersSent: [...sent, 'streak-risk'] });

      // Only ping members who haven't checked in and have an active streak
      const atRisk = [];
      for (const uid of (g.memberIds || [])) {
        const member = (g.members || []).find(m => m.uid === uid);
        if (member?.arrivedAt) continue; // already checked in
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) continue;
        const streak = userDoc.data().currentStreak || 0;
        if (streak > 0) atRisk.push({ uid, streak });
      }

      for (const { uid, streak } of atRisk) {
        await sendPushToUids(
          [uid],
          `Streak at risk`,
          `Your ${streak}-day streak could break — "${g.name}" starts in 30 min. Don't miss it.`
        );
      }
      if (atRisk.length) console.log(`Streak-risk nudge sent for "${g.name}" to ${atRisk.length} members`);
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
