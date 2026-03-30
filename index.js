const express = require("express");
const path = require("path");
const app = express();
const session = require("express-session");
const PORT = 3000;
const http = require('http');
const { Server } = require("socket.io");
const server = http.createServer(app);
const io = new Server(server);

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });
});

function update(){
    io.emit("update", {
        highest_bet: highest_bet,
        pot: pula,
        round: rounds[round],
        showdownReady: showdownReady,
    });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: "8d1e7f2c9a4b6duf8weyfay2r63n9t2tvr6q",
    resave: false,
    saveUninitialized: true,
}));

let highest_bet = 0;
let pula = 0;
let rounds = ["Pre-flop", "Flop", "Turn", "River"];
let round = 0;
let showdownReady = false;


function sprawdz_money(req) {
    if (req.session.money === undefined) {
        req.session.money = 1000;
    }
}
function sprawdz_player_bet(req) {
    if (req.session.player_bet === undefined) {
        req.session.player_bet = 0;
    }
}



function nextRound(){
    pula = 0;
    highest_bet = 0;
    round += 1;
    showdownReady = false;
}


// BAZA DANYCH
const mysql = require("mysql2");

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "",
    database: "Poker"
});

db.connect(err => {
    if (err) throw err;
    console.log("Połączono z bazą");
});

function update_money(money,username){
    db.query(
        "UPDATE `uzytkownicy` SET money = ? WHERE username = ?",
        [money, username],
        (error, result) => {
            if (error) {
                console.error("update_money ERROR: ", error);
                return;
            }

            if (result.affectedRows === 0) {
                console.warn(`Nie znaleziono użytkownika: ${username}`);
                return;
            }

            console.log(`${username}: ${money}`);
        }
    );
}
function check_money(username) {
    return new Promise((resolve, reject) => {
        db.query(
            "SELECT money FROM `uzytkownicy` WHERE username = ?",
            [username],
            (error, result) => {
                if (error) {
                    console.error("check_money ERROR: ", error);
                    return reject(error);
                }

                if (result.length === 0) {
                    return resolve(1000);
                }

                resolve(result[0].money);
            }
        );
    });
}


app.post('/register', (req,res) => {
    db.query(
        "INSERT INTO `uzytkownicy` (username, password, money) VALUES (?, ?, ?)",
        [req.body.username, req.body.password, 1000],
        (error, result) => {
            if (error) throw error;

            console.log(`insert: ${req.body.username} ${req.body.password}`)
            console.log(result.insertId);

            req.session.username = req.body.username;
            req.session.money = 1000;
            req.session.logged = true;

            res.redirect('/');
        }
    );
})

app.post('/login', (req,res) => {
    db.query(
        "SELECT username, password FROM `uzytkownicy` WHERE username = ? AND password = ?",
        [req.body.username, req.body.password],

        (error, result) => {
            if (error) throw error;
            
            if(result.length === 0){
                console.log("Unknown user")

                return res.status(401).json({
                    error: "Nieprawidłowy login lub hasło"
                });
            }
            console.log(`User ${req.body.username} has logged :)`);

            req.session.username = result[0].username;
            req.session.logged = true;

            res.redirect('/');

            console.log("BODY:", req.body);
            console.log("USERNAME:", `${req.body.username}`);
            console.log("PASSWORD:", `${req.body.password}`);
        }
    );
})




app.get('/register', (req,res) => {
    res.sendFile(path.join(__dirname, 'rejestracja.html'));
})

app.get('/login', (req,res) => {
    res.sendFile(path.join(__dirname, 'logowanie.html'));
})




app.get('/', (req,res) => {
    if(req.session.logged === undefined){
        res.redirect('/login');
    }
    else{
        update();
        res.sendFile(path.join(__dirname, 'index.html'));
        
    }

    if (req.session.permission === undefined){
        req.session.permission = false;
    }
})



app.post('/add', (req,res) => {
    if(req.session.folded === false || req.session.folded === undefined){
        
        sprawdz_money(req);
        sprawdz_player_bet(req);

        const bet = Number(req.body.bet);

        let action = '';
        if (req.body.action == "check") {
            if(req.session.player_bet === highest_bet){
                action = 'check';
            }
        }

        else if (req.body.action == "raise") {
            if (bet <= 0 || bet < (highest_bet * 2)) {
                return res.status(400).json({
                    error: `Minimalny bet to ${highest_bet * 2}`
                });
            }

            if (bet > req.session.money) {
                return res.status(400).json({
                    error: "Nie masz tylu pieniędzy"
                });
            }
            action = 'raise';
            req.session.money -= bet;
            req.session.player_bet = bet;
            pula += bet;

            if(bet > highest_bet){
                highest_bet = bet;
            }
        }

        else if (req.body.action == "call") {
            if(req.session.money >= highest_bet - req.session.player_bet){
                if(req.session.money !== highest_bet){
                    action = 'call';
                    req.session.MadeMove = true;
                    
                    req.session.money -= highest_bet - req.session.player_bet;
                    pula += highest_bet - req.session.player_bet;
                    req.session.player_bet = highest_bet;
                    
                    update_money(req.session.money, req.session.username);
                }
                else{
                    return res.status(403).json({
                        error: 'Nie mozesz dodac 0'
                    });
                }
            }
            else{
                return res.status(403).json({
                    error: 'Masz za mało pieniędzy'
                })
            }
        }

        else if (req.body.action == "fold") {
            action = 'fold';
            req.session.player_bet = 0;
            req.session.folded = true;
            req.session.MadeMove = false;
        }

        update();
        update_money(req.session.money, req.session.username)

        return res.json({
                action: action,
                player_bet: req.session.player_bet,
                money: req.session.money,
            });
    }
    else{
        return res.status(400).json({
            error: "Nie mozesz wykonac ruchu"
        });
    }
});



app.get('/perm', (req,res) => {
    req.session.permission = true;
    console.log("Granted permission to " + req.sessionID)
    console.log(req.session.permission)
    res.redirect('/')
})




app.post('/zmien_runde', (req,res) => {
    if (req.session.permission !== true) {
        return res.status(403).json({
            error: 'Brak uprawnień'
        });
    }

    highest_bet = 0;
    showdownReady = false;

    round += 1;

    if (round >= rounds.length) {
        round = rounds.length - 1;
        showdownReady = true;
    }

    return res.json({
        round: rounds[round],
        showdownReady: showdownReady
    });
})




app.post('/win', (req,res) => {
    req.session.money += pula;
    db.query(
        "UPDATE uzytkownicy SET money = ? WHERE username = ?;",
        [req.session.money, req.session.username],
        (error, result) => {
            if (error) throw error;

            console.log(`User ${req.session.username} has won`);

            res.send(`<p>${req.session.username} has won!`);
        }
    );
});



app.get('/state', async (req, res) => {
    if (req.session.money === undefined) req.session.money = 1000;
    if (req.session.player_bet === undefined) req.session.player_bet = 0;
    if (req.session.permission === undefined) req.session.permission = false;

    try{
        req.session.money = await check_money(req.session.username);

        res.json({
            money: req.session.money,
            player_bet: req.session.player_bet,
            highest_bet: highest_bet,
            pot: pula,
            round: rounds[round],
            showdownReady: showdownReady
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Błąd bazy danych' });
    }
});



app.get('/money', (req, res) => {
    req.session.money += 1000;

    update_money(req.session.money, req.session.username)
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Działa na porcie http://localhost:${PORT}`);
});