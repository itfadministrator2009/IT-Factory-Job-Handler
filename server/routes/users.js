const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');

const router = express.Router();
router.use(authRequired);

router.get('/', (req, res) => {
  const users = db.prepare('SELECT id, name, email FROM users ORDER BY name').all();
  res.json({ users });
});

module.exports = router;
