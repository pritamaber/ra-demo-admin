'use strict';
// Wipes the database and reloads the demo data:  npm run reset
const { resetDemo } = require('../src/seed');
resetDemo();
console.log('Demo data reset.');
