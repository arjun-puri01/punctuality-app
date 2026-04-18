const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

const app = express();

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id
});

const db = admin.firestore();

// Middleware
app.use(cors({
  origin: '*'
}));
app.use(express.json());

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

// Helper: create a notification doc
async function createNotification(userId, type, message) {
  await db.collection('notifications').add({
    userId,
    type,
    message,
    read: false,
    createdAt: new Date()
  });
}

// Get notifications for a user
app.get('/api/notifications', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const snapshot = await db.collection('notifications')
      .where('userId', '==', userId)
      .get();

    const notifications = [];
    snapshot.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));
    notifications.sort((a, b) => {
      const ta = a.createdAt?._seconds ?? 0;
      const tb = b.createdAt?._seconds ?? 0;
      return tb - ta;
    });
    notifications.splice(30);
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark all notifications as read for a user
app.post('/api/notifications/markRead', async (req, res) => {
  try {
    const { userId } = req.body;
    const snapshot = await db.collection('notifications')
      .where('userId', '==', userId)
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

// Create a new gathering
app.post('/api/gatherings', async (req, res) => {
  try {
    const { name, time, location, lat, lng, invitedUserIds, userId } = req.body;

    // Fetch creator's profile
    const creatorDoc = await db.collection('users').doc(userId).get();
    const creatorName = creatorDoc.exists ? (creatorDoc.data().name || 'Unknown') : 'Unknown';

    // Fetch each invited user's profile
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
      name,
      time,
      location,
      lat: lat ?? null,
      lng: lng ?? null,
      userId,
      memberIds: members.map(m => m.uid),
      createdAt: new Date(),
      members
    };

    const docRef = await db.collection('gatherings').add(gathering);

    // Notify all invitees
    await Promise.all(
      (invitedUserIds || []).map(uid =>
        createNotification(uid, 'gathering_invite',
          `${creatorName} invited you to "${name}"`)
      )
    );

    res.json({ id: docRef.id, ...gathering });
  } catch (error) {
    console.error('Error creating gathering:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all gatherings for a user (created by them or invited to)
app.get('/api/gatherings', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Two queries: gatherings they created, and gatherings they were invited to
    const [createdSnapshot, memberSnapshot] = await Promise.all([
      db.collection('gatherings').where('userId', '==', userId).get(),
      db.collection('gatherings').where('memberIds', 'array-contains', userId).get()
    ]);

    // Merge and deduplicate by doc id
    const gatheringMap = {};
    createdSnapshot.forEach(doc => {
      gatheringMap[doc.id] = { id: doc.id, ...doc.data() };
    });
    memberSnapshot.forEach(doc => {
      gatheringMap[doc.id] = { id: doc.id, ...doc.data() };
    });

    res.json(Object.values(gatheringMap));
  } catch (error) {
    console.error('Error fetching gatherings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific gathering
app.get('/api/gatherings/:id', async (req, res) => {
  try {
    const doc = await db.collection('gatherings').doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Gathering not found' });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error('Error fetching gathering:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check in (mark yourself as arrived)
app.post('/api/gatherings/:id/checkin', async (req, res) => {
  try {
    const { userId, lat, lng } = req.body;
    const gatheringRef = db.collection('gatherings').doc(req.params.id);
    const gatheringDoc = await gatheringRef.get();

    if (!gatheringDoc.exists) {
      return res.status(404).json({ error: 'Gathering not found' });
    }

    const gathering = gatheringDoc.data();
    const memberIndex = gathering.members.findIndex(m => m.uid === userId);

    if (memberIndex === -1) {
      return res.status(404).json({ error: 'You are not a member of this gathering' });
    }

    const arrivedAt = new Date();
    const scheduledTime = new Date(gathering.time);
    const timeDiff = (arrivedAt - scheduledTime) / 1000 / 60; // minutes since scheduled start

    // Block check-in more than 60 minutes before the event
    if (timeDiff < -60) {
      const minsUntil = Math.round(-timeDiff);
      const hoursUntil = Math.floor(minsUntil / 60);
      const label = hoursUntil > 0
        ? `${hoursUntil}h ${minsUntil % 60}m`
        : `${minsUntil} minutes`;
      return res.status(400).json({ error: `This gathering starts in ${label} — check in opens 60 minutes before` });
    }

    const isOnTime = timeDiff <= 0; // on time = arrived at or before the scheduled time

    // GPS verification — only if gathering has coordinates and user sent coordinates
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

    // Update user's points and streak
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.exists ? userDoc.data() : {};

    const currentStreak = userData.currentStreak || 0;
    const longestStreak = userData.longestStreak || 0;
    const currentPoints = userData.points || 0;

    const newStreak = isOnTime ? currentStreak + 1 : 0;
    const newPoints = isOnTime ? currentPoints + 10 : Math.max(0, currentPoints - 5);
    const newLongest = Math.max(longestStreak, newStreak);

    await userRef.update({
      points: newPoints,
      currentStreak: newStreak,
      longestStreak: newLongest
    });

    res.json({ ...gathering.members[memberIndex], points: newPoints, currentStreak: newStreak });
  } catch (error) {
    console.error('Error checking in:', error);
    res.status(500).json({ error: error.message });
  }
});

// Edit a gathering (creator only)
app.put('/api/gatherings/:id', async (req, res) => {
  try {
    const { userId, name, time, location, lat, lng } = req.body;
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

// Add members to an existing gathering (creator only)
app.post('/api/gatherings/:id/invite', async (req, res) => {
  try {
    const { userId, invitedUserIds } = req.body;
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
          arrivedAt: null,
          isOnTime: null
        };
      })
    );

    const updatedMembers = [...gathering.members, ...newMembers];
    const updatedMemberIds = [...gathering.memberIds, ...newUids];
    await gatheringRef.update({ members: updatedMembers, memberIds: updatedMemberIds });

    // Notify newly added members
    const creatorDoc = await db.collection('users').doc(gathering.userId).get();
    const creatorName = creatorDoc.exists ? (creatorDoc.data().name || 'Someone') : 'Someone';
    await Promise.all(
      newUids.map(uid =>
        createNotification(uid, 'gathering_invite',
          `${creatorName} added you to "${gathering.name}"`)
      )
    );

    res.json({ id: req.params.id, ...gathering, members: updatedMembers, memberIds: updatedMemberIds });
  } catch (error) {
    console.error('Error adding members:', error);
    res.status(500).json({ error: error.message });
  }
});

// Leave a gathering
app.post('/api/gatherings/:id/leave', async (req, res) => {
  try {
    const { userId } = req.body;
    const gatheringRef = db.collection('gatherings').doc(req.params.id);
    const gatheringDoc = await gatheringRef.get();

    if (!gatheringDoc.exists) return res.status(404).json({ error: 'Gathering not found' });
    const gathering = gatheringDoc.data();
    if (gathering.userId === userId) return res.status(400).json({ error: 'Creator cannot leave — delete the gathering instead' });

    const updatedMembers = gathering.members.filter(m => m.uid !== userId);
    const updatedMemberIds = gathering.memberIds.filter(uid => uid !== userId);
    await gatheringRef.update({ members: updatedMembers, memberIds: updatedMemberIds });

    res.json({ success: true });
  } catch (error) {
    console.error('Error leaving gathering:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a gathering (creator only)
app.delete('/api/gatherings/:id', async (req, res) => {
  try {
    const { userId } = req.query;
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

// Leaderboard for a user's friend group
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    // Get accepted friends
    const friendsSnapshot = await db.collection('friends')
      .where('users', 'array-contains', userId)
      .get();

    const friendUids = [];
    friendsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.status === 'accepted') {
        friendUids.push(data.users.find(uid => uid !== userId));
      }
    });

    const allUids = [userId, ...friendUids];

    // Fetch profiles and gathering stats for everyone in parallel
    const profiles = {};
    await Promise.all(allUids.map(async uid => {
      const doc = await db.collection('users').doc(uid).get();
      if (doc.exists) profiles[uid] = doc.data();
    }));

    const stats = await Promise.all(allUids.map(async uid => {
      const snapshot = await db.collection('gatherings')
        .where('memberIds', 'array-contains', uid)
        .get();

      let attended = 0, onTime = 0, late = 0;
      snapshot.forEach(doc => {
        const member = doc.data().members?.find(m => m.uid === uid);
        if (member?.arrivedAt !== null && member?.arrivedAt !== undefined) {
          attended++;
          if (member.isOnTime) onTime++;
          else late++;
        }
      });

      const profile = profiles[uid] || {};
      let totalMinuteOffset = 0;
      snapshot.forEach(doc => {
        const member = doc.data().members?.find(m => m.uid === uid);
        if (member?.arrivedAt != null) {
          const arrivedMs = member.arrivedAt._seconds
            ? member.arrivedAt._seconds * 1000
            : new Date(member.arrivedAt).getTime();
          const scheduledMs = new Date(doc.data().time).getTime();
          totalMinuteOffset += (arrivedMs - scheduledMs) / 1000 / 60;
        }
      });
      return {
        uid,
        name: profile.name || 'Unknown',
        username: profile.username || '',
        attended,
        onTime,
        late,
        punctualityRate: attended > 0 ? Math.round((onTime / attended) * 100) : null,
        avgMinutes: attended > 0 ? Math.round(totalMinuteOffset / attended) : null,
        points: profile.points || 0,
        currentStreak: profile.currentStreak || 0,
        longestStreak: profile.longestStreak || 0,
        isYou: uid === userId
      };
    }));

    // Sort by points descending, then punctuality rate as tiebreaker
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

// Individual check-in history for a user (for trend charts)
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

// Search users by username
app.get('/api/users/search', async (req, res) => {
  try {
    const { username, userId } = req.query;
    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    const snapshot = await db.collection('users')
      .where('username', '==', username)
      .get();

    const users = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Don't return the searching user themselves
      if (data.uid !== userId) {
        users.push({ uid: data.uid, name: data.name, username: data.username });
      }
    });

    res.json(users);
  } catch (error) {
    console.error('Error searching users:', error);
    res.status(500).json({ error: error.message });
  }
});

// Public profile stats for any user
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
    snapshot.forEach(doc => {
      const member = doc.data().members?.find(m => m.uid === uid);
      if (member?.arrivedAt != null) {
        attended++;
        if (member.isOnTime) onTime++; else late++;
        const arrivedMs = member.arrivedAt._seconds
          ? member.arrivedAt._seconds * 1000
          : new Date(member.arrivedAt).getTime();
        totalMinuteOffset += (arrivedMs - new Date(doc.data().time).getTime()) / 1000 / 60;
      }
    });
    res.json({
      uid,
      name: profile.name || 'Unknown',
      username: profile.username || '',
      points: profile.points || 0,
      currentStreak: profile.currentStreak || 0,
      longestStreak: profile.longestStreak || 0,
      attended, onTime, late,
      punctualityRate: attended > 0 ? Math.round((onTime / attended) * 100) : null,
      avgMinutes: attended > 0 ? Math.round(totalMinuteOffset / attended) : null,
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send a friend request
app.post('/api/friends/request', async (req, res) => {
  try {
    const { fromUserId, toUserId } = req.body;
    if (!fromUserId || !toUserId) {
      return res.status(400).json({ error: 'fromUserId and toUserId are required' });
    }

    // Check if a request or friendship already exists
    const existing = await db.collection('friends')
      .where('users', 'array-contains', fromUserId)
      .get();

    for (const doc of existing.docs) {
      const data = doc.data();
      if (data.users.includes(toUserId)) {
        return res.status(400).json({ error: 'Friend request already sent or already friends' });
      }
    }

    const friendRequest = {
      users: [fromUserId, toUserId],
      fromUserId,
      toUserId,
      status: 'pending',
      createdAt: new Date()
    };

    const docRef = await db.collection('friends').add(friendRequest);
    res.json({ id: docRef.id, ...friendRequest });
  } catch (error) {
    console.error('Error sending friend request:', error);
    res.status(500).json({ error: error.message });
  }
});

// Accept a friend request
app.post('/api/friends/accept', async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required' });
    }

    const docRef = db.collection('friends').doc(requestId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Friend request not found' });
    }

    await docRef.update({ status: 'accepted' });

    // Notify the person who sent the original request
    const data = doc.data();
    const acceptorDoc = await db.collection('users').doc(data.toUserId).get();
    const acceptorName = acceptorDoc.exists ? (acceptorDoc.data().name || 'Someone') : 'Someone';
    await createNotification(data.fromUserId, 'friend_accepted',
      `${acceptorName} accepted your friend request`);

    res.json({ id: requestId, ...data, status: 'accepted' });
  } catch (error) {
    console.error('Error accepting friend request:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all friends and pending requests for a user
app.get('/api/friends', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const snapshot = await db.collection('friends')
      .where('users', 'array-contains', userId)
      .get();

    const friends = [];
    const pendingReceived = [];
    const pendingSent = [];

    // Collect all unique UIDs we need to look up
    const uidsToFetch = new Set();
    snapshot.forEach(doc => {
      const data = doc.data();
      const otherUid = data.users.find(uid => uid !== userId);
      uidsToFetch.add(otherUid);
    });

    // Fetch all user profiles in parallel
    const userProfiles = {};
    await Promise.all([...uidsToFetch].map(async uid => {
      const userDoc = await db.collection('users').doc(uid).get();
      if (userDoc.exists) {
        userProfiles[uid] = userDoc.data();
      }
    }));

    snapshot.forEach(doc => {
      const data = doc.data();
      const otherUid = data.users.find(uid => uid !== userId);
      const profile = userProfiles[otherUid] || { name: 'Unknown', username: 'unknown' };

      const entry = {
        requestId: doc.id,
        uid: otherUid,
        name: profile.name,
        username: profile.username,
        status: data.status
      };

      if (data.status === 'accepted') {
        friends.push(entry);
      } else if (data.status === 'pending') {
        if (data.toUserId === userId) {
          pendingReceived.push(entry);
        } else {
          pendingSent.push(entry);
        }
      }
    });

    res.json({ friends, pendingReceived, pendingSent });
  } catch (error) {
    console.error('Error fetching friends:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});