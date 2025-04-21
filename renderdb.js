const { Client } = require('pg');

// Setup the PostgreSQL client with your Render database credentials
const client = new Client({
  user: 'aditya',  // Your Render DB username
  host: 'dpg-d01r24be5dus73bg1gag-a.oregon-postgres.render.com',  // Your Render DB host
  database: 'omegel_db1',  // Your database name
  password: 'aivkpieniCFqVrEnSmpafwuXGQaQ2IKe',  // Your Render DB password
  port: 5432,  // Default PostgreSQL port
  ssl: {
    rejectUnauthorized: false  // If Render requires SSL, set this to false
  }
});

// Function to connect to the database and handle errors
const connectToDatabase = async () => {
  try {
    await client.connect();
    console.log('Connected to the PostgreSQL database!');
  } catch (error) {
    console.error('Error connecting to database:', error.message);
    setTimeout(connectToDatabase, 5000);  // Retry connection after 5 seconds
  }
};

// Call the connection function
connectToDatabase();

// Setup a basic express server to handle web requests
const express = require('express');
const app = express();

// Define a simple route to test
app.get('/', (req, res) => {
  res.send('Hello, world!');
});

// Start the server
app.listen(3000, () => {
  console.log('Server is running at http://localhost:3000');
});

// Simple database query example to verify
app.get('/users', async (req, res) => {
  try {
    const result = await client.query('SELECT * FROM users');
    res.json(result.rows);
  } catch (err) {
    console.error('Error executing query:', err.stack);
    res.status(500).send('Database query failed');
  }
});
