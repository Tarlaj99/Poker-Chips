const mysql = require("mysql2/promise");

async function setup(){
    const db = await mysql.createConnection({host: "localhost", user: "root", password: ""});
    await db.query(`CREATE DATABASE IF NOT EXISTS Poker`);
    await db.query(`USE Poker`);
    await db.query(`
        CREATE TABLE IF NOT EXISTS uzytkownicy(
            id INT PRIMARY KEY AUTO_INCREMENT,
            username VARCHAR(50) NOT NULL,
            password VARCHAR(255) NOT NULL,
            money INT NOT NULL DEFAULT 1000
        )
    `)
    await db.end();
    console.log('Setup zakończony sukcesem');
}

module.exports = setup;

