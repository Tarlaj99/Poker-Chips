const express = require("express");
const path = require("path");
const app = express();
const session = require("express-session");
const PORT = 3000;
const http = require("http");
const { Server } = require("socket.io");
const server = http.createServer(app);
const io = new Server(server);

const rounds = ["Pre-flop", "Flop", "Turn", "River"];
const tables = new Map();
// hej
console.log("File:", __filename);

const setup = require("./db_setup");
const mysql = require("mysql2");

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "",
    database: "Poker"
});

async function startServer() {
    try {
        await setup();

        db.connect(err => {
            if (err) throw err;
            console.log("Połączono z bazą");

            server.listen(PORT, "0.0.0.0", () => {
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

const sessionMiddleware = session({
    secret: "8d1e7f2c9a4b6duf8weyfay2r63n9t2tvr6q",
    resave: false,
    saveUninitialized: true,
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });

    socket.on("join_table", () => {
        const tableID = socket.request.session.tableID;
        const username = socket.request.session.username;

        if (tableID && username) {
            socket.join(tableID);
            socket.join(`user:${username}`);
            console.log(`${username} joined ${tableID}`);
        }
    });

    socket.on("I_won", () => {
        const tableID = socket.request.session.tableID;
        const username = socket.request.session.username;
        const table = tables.get(tableID);

        if (!table) return;

        const player = table.players.get(username);
        if (!player) return;

        awardWinner(tableID, table, player, false);
    });
});

function createPlayer(username) {
    return {
        username,
        money: 1000,
        bet: 0,
        totalBet: 0,
        madeMove: false,
        folded: false,
        allIn: false,
    };
}

function createTable() {
    return {
        pot: 0,
        highest_bet: 0,
        players: new Map(),
        moves: 0,
        num_players: 0,
        sidepots: [],
        round: 0,
    };
}

function recalculatePot(table) {
    let pot = 0;

    for (const player of table.players.values()) {
        pot += player.totalBet;
    }

    table.pot = pot;
}

function calculateSidePots(table) {
    const players = [...table.players.values()];

    // Side pots exist only when at least one player is all in.
    if (!players.some(player => player.allIn)) {
        return [];
    }

    const betLevels = [...new Set(
        players
            .map(player => player.totalBet)
            .filter(totalBet => totalBet > 0)
    )].sort((a, b) => a - b);

    const sidepots = [];
    let previousLevel = 0;

    for (const level of betLevels) {
        const contributors = players.filter(player => player.totalBet >= level);
        const amount = (level - previousLevel) * contributors.length;
        const eligiblePlayers = contributors
            .filter(player => !player.folded)
            .map(player => player.username);

        if (amount > 0) {
            sidepots.push({
                amount,
                cap: level,
                eligiblePlayers,
            });
        }

        previousLevel = level;
    }

    return sidepots;
}

function refreshSidePots(table) {
    recalculatePot(table);
    table.sidepots = calculateSidePots(table);
}

function addToPot(table, player, amount) {
    const amountToAdd = Math.min(Number(amount), player.money);

    if (!Number.isFinite(amountToAdd) || amountToAdd <= 0) {
        return 0;
    }

    player.money -= amountToAdd;
    player.bet += amountToAdd;
    player.totalBet += amountToAdd;

    if (player.money === 0) {
        player.allIn = true;
    }

    refreshSidePots(table);
    return amountToAdd;
}

function resetCurrentBettingRound(table) {
    table.highest_bet = 0;

    for (const player of table.players.values()) {
        player.bet = 0;
        player.madeMove = false;
    }
}

function resetHand(table) {
    table.pot = 0;
    table.highest_bet = 0;
    table.sidepots = [];
    table.round = 0;

    for (const player of table.players.values()) {
        player.bet = 0;
        player.totalBet = 0;
        player.madeMove = false;
        player.folded = false;
        player.allIn = false;
    }
}

function getPlayersWhoCanAct(table) {
    return [...table.players.values()].filter(player => !player.folded && !player.allIn);
}

function isRoundReady(table) {
    if(table.moves < 2) return false;
    const playersWhoCanAct = getPlayersWhoCanAct(table);

    if (playersWhoCanAct.length === 0) {
        return true;
    }

    return playersWhoCanAct.every(player => {
        return player.madeMove && player.bet === table.highest_bet;
    });
}

function emitTableUpdate(tableID, nextRoundReady = false) {
    const table = tables.get(tableID);
    if (!table) return;

    refreshSidePots(table);

    io.to(tableID).emit("update", {
        next_round_ready: nextRoundReady,
        highest_bet: table.highest_bet,
        pot: table.pot,
        round: table.round,
        sidepots: table.sidepots,
    });
}

function moveToNextRoundOrShowdown(tableID, table) {
    table.round += 1;
    resetCurrentBettingRound(table);
    refreshSidePots(table);

    if (table.round >= rounds.length || CheckIfEveryoneAllin(table)) {
        io.to(tableID).emit("next hand", {
            pot: table.pot,
            sidepots: table.sidepots,
        });
        return;
    }

    emitTableUpdate(tableID, true);
}
function CheckIfEveryoneAllin(table){
    for(const player of table.players.values()){
        if(!player.allIn) return false;
    }
    return true;
}
function awardWinner(tableID, table, player, wonByFold = false) {
    refreshSidePots(table);

    let amountWon = 0;

    if (wonByFold || table.sidepots.length === 0) {
        amountWon = table.pot;
    }
    else {
        for (const sidepot of table.sidepots) {
            if (sidepot.eligiblePlayers.includes(player.username)) {
                amountWon += sidepot.amount;
            }
        }

        if (amountWon === 0) {
            amountWon = table.pot;
        }
    }

    player.money += amountWon;

    const winnerUsername = player.username;
    resetHand(table);

    io.to(tableID).emit("winner", {
        winner: winnerUsername,
        amount: amountWon,
    });
}

function checkFold(tableID) {
    const table = tables.get(tableID);
    if (!table) return false;

    const activePlayers = [...table.players.values()].filter(player => !player.folded);

    if (activePlayers.length === 1 && table.players.size > 1) {
        awardWinner(tableID, table, activePlayers[0], true);
        return true;
    }

    return false;
}

function join_table(tableID, username) {
    const table = tables.get(tableID);
    if (!table) return;

    if (!table.players.has(username)) {
        table.players.set(username, createPlayer(username));
        table.num_players = table.players.size;
    }

    const player = table.players.get(username);

    if (table.round !== 0 || table.pot > 0) {
        player.folded = true;
        player.madeMove = true;
    }
}

function update_money(req) {
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

app.post("/create_table", (req, res) => {
    const tableID = req.body.id?.trim();

    if (!tableID) {
        return res.status(400).json({
            error: "Table ID is required"
        });
    }

    if (tables.has(tableID)) {
        return res.status(403).json({
            error: "The table with that ID already exists"
        });
    }

    tables.set(tableID, createTable());
    req.session.tableID = tableID;
    join_table(tableID, req.session.username);

    return req.session.save(() => {
        res.json({
            redirect: "/main"
        });
    });
});

app.post("/join_table", (req, res) => {
    const tableID = req.body.id?.trim();

    if (!tableID) {
        return res.status(400).json({
            error: "Table ID is required"
        });
    }

    if (!tables.has(tableID)) {
        return res.status(403).json({
            error: "Table not found. Make sure you typed the ID correctly"
        });
    }

    req.session.tableID = tableID;
    join_table(tableID, req.session.username);

    return req.session.save(() => {
        res.json({
            redirect: "/main"
        });
    });
});

app.get("/leave_table", (req, res) => {
    const tableID = req.session.tableID;

    if (tableID) {
        const table = tables.get(tableID);

        if (table) {
            table.players.delete(req.session.username);
            table.num_players = table.players.size;

            if (table.players.size === 0) {
                tables.delete(tableID);
            }
            else {
                checkFold(tableID);
                emitTableUpdate(tableID);
            }
        }
    }

    delete req.session.tableID;

    return req.session.save(() => {
        res.redirect("/");
    });
});

app.post("/register", (req, res) => {
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

            return req.session.save(() => {
                res.json({
                    redirect: "/"
                });
            });
        }
    );
});

app.post("/login", (req, res) => {
    db.query(
        "SELECT username, password FROM `uzytkownicy` WHERE username = ? AND password = ?",
        [req.body.username, req.body.password],
        (error, result) => {
            if (error) throw error;

            if (result.length === 0) {
                return res.status(401).json({
                    error: "Invalid username/password"
                });
            }

            req.session.username = result[0].username;
            req.session.logged = true;

            return req.session.save(() => {
                res.json({
                    redirect: "/"
                });
            });
        }
    );
});

app.get("/login", (req, res) => {
    return res.sendFile(path.join(__dirname, "logowanie.html"));
});

app.get("/", (req, res) => {
    if (!req.session.logged) {
        return res.redirect("/login");
    }

    if (req.session.tableID !== undefined) {
        return res.redirect("/main");
    }

    return res.sendFile(path.join(__dirname, "table.html"));
});

app.get("/table", (req, res) => {
    if (!req.session.logged) {
        return res.redirect("/login");
    }

    if (req.session.tableID !== undefined) {
        return res.redirect("/main");
    }

    return res.sendFile(path.join(__dirname, "table.html"));
});

app.get("/main", (req, res) => {
    if (!req.session.logged) {
        return res.redirect("/login");
    }

    if (req.session.tableID === undefined) {
        return res.redirect("/table");
    }

    return res.sendFile(path.join(__dirname, "main.html"));
});

app.post("/move", (req, res) => {
    const tableID = req.session.tableID;
    const username = req.session.username;
    const table = tables.get(req.session.tableID);

    if (!table) {
        return res.status(404).json({
            error: "Table not found"
        });
    }

    const player = table.players.get(username);

    if (!player) {
        return res.status(404).json({
            error: "Player not found at this table"
        });
    }

    if (table.players.size < 2) {
        return res.status(400).json({
            error: "Wait for other players to join"
        });
    }

    if (player.folded) {
        return res.status(400).json({
            error: "Your hand is folded"
        });
    }

    if (player.allIn) {
        return res.status(400).json({
            error: "You are already all in"
        });
    }

    const action = req.body.action;
    const requestedBet = Number(req.body.bet);

    if (action === "raise") {
        if (!Number.isFinite(requestedBet)) {
            return res.status(400).json({
                error: "Invalid bet"
            });
        }

        const minimumRaise = table.highest_bet === 0 ? 2 : table.highest_bet * 2;
        const maxPossibleBet = player.bet + player.money;

        if (requestedBet <= table.highest_bet) {
            return res.status(400).json({
                error: "Raise must be higher than current highest bet"
            });
        }

        if (requestedBet < minimumRaise && requestedBet < maxPossibleBet) {
            return res.status(400).json({
                error: `Minimal bet is $${minimumRaise}`
            });
        }

        if (requestedBet > maxPossibleBet) {
            return res.status(400).json({
                error: "Not enough money"
            });
        }

        const previousHighestBet = table.highest_bet;
        const amountToAdd = requestedBet - player.bet;
        addToPot(table, player, amountToAdd);

        if (player.bet > previousHighestBet) {
            table.highest_bet = player.bet;

            for (const otherPlayer of table.players.values()) {
                if (!otherPlayer.folded && !otherPlayer.allIn) {
                    otherPlayer.madeMove = false;
                }
            }
        }

        player.madeMove = true;
    }
    else if (action === "call") {
        const amountToCall = table.highest_bet - player.bet;

        if (amountToCall <= 0) {
            return res.status(403).json({
                error: "There's nothing to call"
            });
        }

        addToPot(table, player, amountToCall);
        player.madeMove = true;
    }
    else if (action === "check") {
        if (table.highest_bet > player.bet) {
            return res.status(400).json({
                error: "Can't check while there's a bet"
            });
        }

        player.madeMove = true;
    }
    else if (action === "fold") {
        player.folded = true;
        player.madeMove = true;

        if (checkFold(tableID)) {
            return res.json({
                action,
                player_bet: player.bet,
                money: player.money,
                folded: player.folded,
                allIn: player.allIn,
            });
        }
    }
    else {
        return res.status(400).json({
            error: "Unknown action"
        });
    }
    table.moves += 1;
    refreshSidePots(table);

    if (isRoundReady(table)) {
        moveToNextRoundOrShowdown(tableID, table);
    }
    else {
        emitTableUpdate(tableID, false);
    }

    return res.json({
        action,
        player_bet: player.bet,
        money: player.money,
        folded: player.folded,
        allIn: player.allIn,
    });
});

app.get("/state", async (req, res) => {
    const tableID = req.session.tableID;
    const username = req.session.username;
    const table = tables.get(tableID);

    if (!table) {
        return res.status(404).json({
            error: "Table not found"
        });
    }

    const player = table.players.get(username);

    if (!player) {
        return res.status(404).json({
            error: "Player not found at this table"
        });
    }

    try {
        req.session.money = await check_money(req);
        refreshSidePots(table);

        return res.json({
            tableID,
            money: player.money,
            player_bet: player.bet,
            total_bet: player.totalBet,
            highest_bet: table.highest_bet,
            pot: table.pot,
            round: table.round,
            folded: player.folded,
            allIn: player.allIn,
            sidepots: table.sidepots,
        });
    }
    catch (error) {
        return res.status(500).json({ error: "Błąd bazy danych" });
    }
});

// Review robią: Szymon i Piotrek.