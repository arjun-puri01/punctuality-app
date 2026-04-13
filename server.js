const express = require('express');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Temporary in-memory storage (we'll upgrade this later)
const gatherings = [];
let gatheringIdCounter = 1;

// Create a new gathering
app.post('/api/gatherings', (req, res) => {
  const { name, time, location, friendNames } = req.body;
  
  const gathering = {
    id: gatheringIdCounter++,
    name,
    time,
    location,
    createdAt: new Date(),
    members: friendNames.map(name => ({
      name,
      arrivedAt: null,
      isOnTime: null
    }))
  };
  
  gatherings.push(gathering);
  res.json(gathering);
});

// Get all gatherings
app.get('/api/gatherings', (req, res) => {
  res.json(gatherings);
});

// Get a specific gathering
app.get('/api/gatherings/:id', (req, res) => {
  const gathering = gatherings.find(g => g.id === parseInt(req.params.id));
  if (!gathering) {
    return res.status(404).json({ error: 'Gathering not found' });
  }
  res.json(gathering);
});

// Check in (mark yourself as arrived)
app.post('/api/gatherings/:id/checkin', (req, res) => {
  const { name } = req.body;
  const gathering = gatherings.find(g => g.id === parseInt(req.params.id));
  
  if (!gathering) {
    return res.status(404).json({ error: 'Gathering not found' });
  }
  
  const member = gathering.members.find(m => m.name === name);
  if (!member) {
    return res.status(404).json({ error: 'Member not found' });
  }
  
  member.arrivedAt = new Date();
  
  // Check if on time (within 5 minutes of scheduled time)
  const scheduledTime = new Date(gathering.time);
  const timeDiff = (member.arrivedAt - scheduledTime) / 1000 / 60; // difference in minutes
  member.isOnTime = timeDiff <= 5;
  
  res.json(member);
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});