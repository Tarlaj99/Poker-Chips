const express = require("express");
const path = require("path");
const app = express();
const session = require("express-session");
const PORT = 3000;
const http = require('http');
const { Server } = require("socket.io");
const server = http.createServer(app);
const io = new Server(server);

const rounds = ["Pre-flop", "Flop", "Turn", "River"];
const tables = new Map();

// Setup bazy danych
const setup = require("./db_setup");

async function startServer() {
    try {
        await setup();

        db.connect(err => {
            if (err) throw err;
            console.log("Połączono z bazą");

            server.listen(PORT, '0.0.0.0', () => {
                console.log(`Działa na porcie http://localhost:${PORT}`);
            });
        });
    }
    catch (error) {
        console.error("Nie udało się przygotować bazy danych:", error);
        process.exit(1);
    }
}
startServer();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//setup socketów:
const sessionMiddleware = session({
    secret: "8d1e7f2c9a4b6duf8weyfay2r63n9t2tvr6q",
    resave: false,
    saveUninitialized: true,
});

app.use(sessionMiddleware); 
io.engine.use(sessionMiddleware); 
// teraz sockety mają dostęp do sesji

// Socket
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });

    socket.on('join_table', () =>{
        const id = socket.request.session.tableID;

        if(id){
            socket.join(id);
            console.log(`${socket.request.session.username} joined ${socket.request.session.tableID}`)
        }
    })

    // to wysyła gościu, który wygra runde
    socket.on('I_won', () => { 
        // zeby zaczaic co tu sie dzieje to Ctrl + F i zapraszam na '/create_table'
        const table = tables.get(socket.request.session.tableID); 
        const player = table.players.get(socket.request.session.username);

        player.money += table.pot;
        table.pot = 0;
        table.highest_bet = 0;
        table.round = 0;

        for(const pl of table.players.values()){
            pl.bet = 0;
            pl.MadeMove = false;
            pl.folded = false;
        }       

        io.to(socket.request.session.tableID).emit('winner', {
            winner: socket.request.session.username,
        }); // to wysyła do wszystkich przy tym stole wiadomosc kto wygral runde
    })
});

function update(tableId,next_round_ready){
    const table = tables.get(tableId);

    if(next_round_ready){
        for(const player of table.players.values()){
            player.bet = 0;
        }
    }
    if(table.round == 4){
        for(const player of table.players.values()){
            player.folded = false;
        }
        io.to(tableId).emit("next hand");
    }
    else{
        io.to(tableId).emit("update", {
            next_round_ready: next_round_ready,
            highest_bet: table.highest_bet,
            pot: table.pot, 
            round: table.round,
        })
    }
}

function sprawdz_money(req) {
    if (req.session.money === undefined) {
        req.session.money = 1000;
    }
    update_money(req);
}
function sprawdz_player_bet(req) {
    if (req.session.bet === undefined) {
        req.session.bet = 0;
    }
}

// BAZA DANYCH
const mysql = require("mysql2");
const { table } = require("console");

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "",
    database: "Poker"
});

function update_money(req){
    db.query(
        "UPDATE `uzytkownicy` SET money = ? WHERE username = ?",
        [req.session.money, req.session.username],
        (error, result) => {
            if (error) {
                console.error("update_money ERROR: ", error);
                return;
            }

            if (result.affectedRows === 0) {
                console.warn(`Nie znaleziono użytkownika: ${req.session.username}`);
                return;
            }

            console.log(`${req.session.username}: ${req.session.money}`);
        }
    );
}

function check_money(req) {
    return new Promise((resolve, reject) => {
        db.query(
            "SELECT money FROM `uzytkownicy` WHERE username = ?",
            [req.session.username],
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
// tables
app.post('/create_table', (req,res) => {
    if(!tables.has(req.body.id)){
        tables.set(req.body.id, {
            pot: 0,
            highest_bet: 0,
            players: new Map(),
            round: 0
        });
        
        join_table(req.session.tableID)

        res.redirect('/main');
    }
    else return res.status(403).json({
        error: 'The table with that ID already exists'
    });
});

app.post('/join_table', (req,res) => {
    if(tables.has(req.body.id)){

        req.session.tableID = req.body.id;
        join_table(req.session.tableID, req.session.username)

        res.redirect('/main');
    }
    else return res.status(403).json({
        error: "Table not found. Make sure you typed the ID correctly"
    });
});

function join_table(tableID,username){

    const table = tables.get(tableID)
    const player = table.players.get(username);

    table.players.set(username, {
        username: username,
        money: 1000,
        bet: 0,
        MadeMove: false,
        folded: false
    });
    
    if(table.round != 0) 
       player.folded = true;    // teraz jak ktoś dołączy w trakcie rundy to będzie czekać na następną, a nie, ze karty na stole, a ten nagle sie pojawia i kladzie bet 
}

app.get('/leave_table', (req,res) => {
    req.session.tableID = undefined;

    res.redirect('/')
});

app.post('/register', (req,res) => {
    db.query(
        "INSERT INTO `uzytkownicy` (username, password) VALUES (?, ?)",
        [req.body.username, req.body.password],
        (error, result) => {
            if (error) throw error;

            console.log(`insert: ${req.body.username} ${req.body.password}`);
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
            console.log(`User ${req.body.username} has logged`);

            req.session.username = result[0].username;
            req.session.logged = true;

            res.redirect('/');
        }
    );
})

app.get('/login', (req,res) => {
    res.sendFile(path.join(__dirname, 'logowanie.html'));
})

app.get('/table', (req,res) => {
    res.sendFile(path.join(__dirname,'table.html'));
})

app.get('/', (req,res) => {
    if(req.session.logged === undefined){
        res.redirect('/login');
    }
    else if(req.session.tableID !== undefined){
        res.redirect('/main');
    }
    else{
        res.sendFile(path.join(__dirname, 'index.html'));
    }
})

// uzytkownik dolacza do gry
app.get('/main', (req,res) => {
    if(req.session.logged === undefined)
        res.redirect('/login');
    
    else if(req.session.tableID === undefined)
        res.redirect('/table')

    else
        res.sendFile(path.join(__dirname, 'main.html'))
})

// check,raise,call,fold
app.post('/move', (req,res) => {
    const table = tables.get(req.session.tableID);
    const player = table.players.get(req.session.username);
    
    if(player.folded){
        return res.status(400).json({
            error: "Your hand is folded"
        });
    }

    // sprawdz_money(req);
    // sprawdz_player_bet(req);

    const bet = Number(req.body.bet);

    if (req.body.action == "raise"){
        if (bet < table.highest_bet * 2) {
            return res.status(400).json({
                error: `The minimal bet is ${table.highest_bet * 2}`
            });
        }

        if (bet > player.money) {
            return res.status(400).json({
                error: "Not enough money"
            });
        }
        player.money -= bet;
        player.bet = bet;
        table.pot += bet;

        if(bet > table.highest_bet){
            table.highest_bet = bet;
        }
    }
    if (req.body.action == "check"){
        if(table.highest_bet > player.bet)
            return res.status(400).json({
                error: "Can't check while there's a bet"
            });
    }
    else if (req.body.action == "call"){
        // jak nie będzie miał kasy to wtedy va banque i side pula to po prostu moze zapisać obecną pulę
        if(player.money >= table.highest_bet - player.bet){
            if(player.money !== table.highest_bet){
                
                player.money -= table.highest_bet - player.bet;
                table.pot += table.highest_bet - player.bet;
                player.bet = table.highest_bet;
                
                // update_money(req)
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
            });
        }
    }

    else if (req.body.action == "fold"){
        action = 'fold';
        player.bet = 0;
        player.folded = true;
        
        return res.json({
            action: req.body.action,
            player_bet: player.bet,
            money: player.money
        });
    }
    player.MadeMove = true

    // sprawdza czy mozna przejsc do nastepnej rundy
    const avg_bet = player.bet;
    let next_round_ready = false;
    for(const pl of table.players.values()){
        if(pl.folded) continue;
        if(!pl.MadeMove){
            next_round_ready = false;
            break;
        } 
        if(pl.bet == avg_bet) next_round_ready = true;
        else {
            next_round_ready = false;
            break;
        }
    }
    if(next_round_ready){
        table.highest_bet = 0;
        table.round += 1;
        for(const player of table.players.values()){
            player.bet = 0;
            player.MadeMove = false
        }
    }

    update(req.session.tableID, next_round_ready);

    return res.json({
            action: req.body.action,
            player_bet: player.bet,
            money: player.money
        });
});



app.get('/state', async (req, res) => {
    const table = tables.get(req.session.tableID);

    if (!table) {
        return res.status(404).json({ error: 'Table not found' });
    }

    const player = table.players.get(req.session.username);

    if (!player) {
        return res.status(404).json({ error: 'Player not found at this table' });
    }

    try{
        req.session.money = await check_money(req);

        res.json({
            tableID: req.session.tableID,
            money: player.money,
            player_bet: player.bet,
            highest_bet: table.highest_bet,
            pot: table.pot,
            round: table.round
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Błąd bazy danych' });
    }
});

// Review robią: Szymon i Piotrek.