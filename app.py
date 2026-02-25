from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from datetime import datetime
from zoneinfo import ZoneInfo
import hashlib
import secrets
import string
import asyncio
import time
import os

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def read_index():
    return FileResponse(os.path.join("static", "index.html"))


# ==========================================================
# WORD OF THE DAY (UNCHANGED)
# ==========================================================
def load_word_list(path: str) -> list[str]:
    words: list[str] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            w = line.strip().lower()
            if len(w) == 5 and w.isalpha():
                words.append(w)

    if not words:
        raise ValueError(f"{path} contains no valid 5-letter words")

    return words


ANSWERS = load_word_list("words/answers.txt")
ALLOWED = set(load_word_list("words/allowed.txt")) | set(ANSWERS)


def todays_answer() -> str:
    tz = ZoneInfo("America/Edmonton")
    today = datetime.now(tz).date().isoformat()
    digest = hashlib.sha256(today.encode("utf-8")).hexdigest()
    return ANSWERS[int(digest, 16) % len(ANSWERS)]


def tilecolor(guess: str, answer: str) -> list[str]:
    result = ["absent"] * 5
    remaining = list(answer)

    # exact matches
    for i in range(5):
        if guess[i] == answer[i]:
            result[i] = "correct"
            remaining.remove(guess[i])

    # present matches
    for i in range(5):
        if result[i] == "correct":
            continue
        if guess[i] in remaining:
            result[i] = "present"
            remaining.remove(guess[i])

    return result


class GuessRequest(BaseModel):
    guess: str
    row: int


@app.post("/api/guess")
def guess_word(body: GuessRequest):
    g = body.guess.strip().lower()

    if len(g) != 5:
        return {"ok": False, "error": "Not 5 letters"}
    if not g.isalpha():
        return {"ok": False, "error": "Letters only"}
    if g not in ALLOWED:
        return {"ok": False, "error": "Not in word list"}

    answer = todays_answer()
    result = tilecolor(g, answer)
    win = g == answer

    res = {"ok": True, "result": result, "isWin": win}
    if (not win) and (body.row == 5):
        res["answer"] = answer

    return res


# ==========================================================
# WEBSOCKETS — ROOMS + READY SYSTEM + BASIC MULTIPLAYER
# ==========================================================
ROOM_LOCK = asyncio.Lock()
ROOMS: dict[str, "Room"] = {}


def gen_code(prefix: str) -> str:
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return f"{prefix}-" + "".join(secrets.choice(chars) for _ in range(6))


def max_players(mode: str) -> int:
    return 2


def normalize_code(code: str) -> str | None:
    code = (code or "").upper().strip()
    allowed = set(string.ascii_uppercase + string.digits)

    # ABC123 -> D-ABC123
    if len(code) == 6 and all(c in allowed for c in code):
        return f"D-{code}"

    # DABC123 -> D-ABC123
    if len(code) == 7 and code[0] == "D" and all(c in allowed for c in code[1:]):
        return f"{code[0]}-{code[1:]}"

    # D-ABC123
    if len(code) == 8 and code[0] == "D" and code[1] == "-" and all(c in allowed for c in code[2:]):
        return code

    return None


class Room:
    def __init__(self, code: str, mode: str, host: str):
        self.code = code
        self.mode = mode
        self.started = False
        self.players: list[dict] = [{"name": host, "isHost": True, "ready": False, "token": None, "connected": True}]
        self.sockets: dict[str, WebSocket] = {}
        self.disconnect_tasks: dict[str, asyncio.Task] = {}
        self.match: dict | None = None

    def is_full(self) -> bool:
        return len(self.players) >= max_players(self.mode)

    def all_ready(self) -> bool:
        return self.is_full() and all(p.get("ready") for p in self.players)

    def names(self) -> set[str]:
        return {p["name"].lower() for p in self.players}


def snapshot(room: Room) -> dict:
    safe_players = []
    for p in room.players:
        safe_players.append({
            "name": p.get("name"),
            "isHost": p.get("isHost", False),
            "ready": p.get("ready", False),
        })
    return {
        "type": "room_state",
        "roomCode": room.code,
        "mode": room.mode,
        "players": safe_players,
        "maxPlayers": max_players(room.mode),
        "allReady": room.all_ready(),
    }


def public_players_state(room: Room) -> list[dict]:
    """Players data safe to broadcast to everyone during a match."""
    out: list[dict] = []
    if not room.match:
        for p in room.players:
            out.append({
                "name": p.get("name"),
                "isHost": p.get("isHost", False),
                "ready": p.get("ready", False),
            })
        return out

    states = room.match.get("players", {})
    for p in room.players:
        name = p["name"]
        st = states.get(name, {})
        out.append({
            "name": name,
            "isHost": p.get("isHost", False),
            "ready": p.get("ready", False),
            "wins": int(st.get("wins", 0)),
            "points": int(st.get("points", 0)),
            "wordIndex": int(st.get("wordIndex", 0)),
            "finished": bool(st.get("finished", False)),
            "roundDone": bool(st.get("roundDone", False)),
            "roundPoints": st.get("roundPoints", [None, None, None]),
        })
    return out


def build_match(room: Room) -> dict:
    # 10-word sequence for sprint modes; 3 words for point modes
    if room.mode == "point":
        sequence_len = 3
    else:
        sequence_len = 10

    sequence = [secrets.choice(ANSWERS) for _ in range(sequence_len)]

    players_state: dict[str, dict] = {}
    for p in room.players:
        players_state[p["name"]] = {
            "wins": 0,
            "points": 0,
            "wordIndex": 0,
            "attemptsThisWord": 0,
            "finished": False,
            "finishAt": None,
            "lastWinAt": None,
            "roundDone": False,
            "roundPoints": [None, None, None],
            "roundStartPoints": 0,
        }

    return {
        "mode": room.mode,
        "sequence": sequence,
        "players": players_state,
        "startAt": None,
        "ended": False,
        "betweenRounds": False,
        "roundReady": {},
    }


def match_snapshot(room: Room) -> dict:
    return {
        "type": "match_state",
        "roomCode": room.code,
        "mode": room.mode,
        "betweenRounds": bool(room.match.get("betweenRounds")) if room.match else False,
        "players": public_players_state(room),
    }

DISCONNECT_GRACE_SECONDS = 5


async def finalize_disconnect(room: Room, token: str, name: str):
    await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
    room_to_broadcast: Room | None = None

    async with ROOM_LOCK:
        # If player reconnected, skip
        for p in room.players:
            if p.get("token") == token and p.get("connected"):
                return

        room.disconnect_tasks.pop(token, None)

        room.sockets.pop(token, None)
        room.players = [p for p in room.players if p.get("token") != token]

        room.started = False
        room.match = None
        for p in room.players:
            p["ready"] = False

        if not room.players:
            ROOMS.pop(room.code, None)
            room_to_broadcast = None
        else:
            room_to_broadcast = room

    if room_to_broadcast:
        if room_to_broadcast.match and room_to_broadcast.match.get("ended"):
            return
        await broadcast(room_to_broadcast, {
            "type": "player_left",
            "roomCode": room_to_broadcast.code,
            "name": name or "A player",
        })


async def safe_send(ws: WebSocket, payload: dict):
    try:
        await ws.send_json(payload)
    except Exception:
        pass


async def broadcast(room: Room, payload: dict):
    for ws in list(room.sockets.values()):
        await safe_send(ws, payload)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()

    joined_room: Room | None = None
    my_name: str | None = None
    my_token: str | None = None

    try:
        while True:
            msg = await ws.receive_json()
            action = msg.get("action")

            # ---------------- CREATE ----------------
            if action == "create":
                name = (msg.get("name") or "").strip()
                mode = (msg.get("mode") or "").strip()

                if not name:
                    await safe_send(ws, {"type": "error", "error": "Name required"})
                    continue
                if mode not in {"sprint", "point"}:
                    await safe_send(ws, {"type": "error", "error": "Invalid mode"})
                    continue

                prefix = "D"

                async with ROOM_LOCK:
                    code = gen_code(prefix)
                    while code in ROOMS:
                        code = gen_code(prefix)

                    room = Room(code, mode, name)
                    token = secrets.token_urlsafe(16)
                    room.players[0]["token"] = token
                    ROOMS[code] = room
                    room.sockets[token] = ws

                    joined_room = room
                    my_name = name
                    my_token = token

                await safe_send(ws, {"type": "created", "token": token, **snapshot(room)})
                await broadcast(room, snapshot(room))
                continue

            # ---------------- JOIN ----------------
            if action == "join":
                name = (msg.get("name") or "").strip()
                code = normalize_code(msg.get("roomCode"))

                if not name:
                    await safe_send(ws, {"type": "error", "error": "Name required"})
                    continue
                if not code:
                    await safe_send(ws, {"type": "error", "error": "Invalid room code"})
                    continue

                async with ROOM_LOCK:
                    room = ROOMS.get(code)
                    if not room:
                        await safe_send(ws, {"type": "error", "error": "Room not found"})
                        continue
                    if room.is_full():
                        await safe_send(ws, {"type": "error", "error": "Room full"})
                        continue
                    if name.lower() in room.names():
                        await safe_send(ws, {"type": "error", "error": "Name taken"})
                        continue

                    token = secrets.token_urlsafe(16)
                    room.players.append({"name": name, "isHost": False, "ready": False, "token": token, "connected": True})
                    room.sockets[token] = ws

                    joined_room = room
                    my_name = name
                    my_token = token

                await safe_send(ws, {"type": "joined", "token": token, **snapshot(room)})
                await broadcast(room, snapshot(room))
                continue

            # ---------------- REJOIN ----------------
            if action == "rejoin":
                code = normalize_code(msg.get("roomCode"))
                token = (msg.get("token") or "").strip()

                if not code or not token:
                    await safe_send(ws, {"type": "error", "error": "Invalid rejoin payload"})
                    continue

                async with ROOM_LOCK:
                    room = ROOMS.get(code)
                    if not room:
                        await safe_send(ws, {"type": "error", "error": "Room not found"})
                        continue

                    player = None
                    for p in room.players:
                        if p.get("token") == token:
                            player = p
                            break
                    if not player:
                        await safe_send(ws, {"type": "error", "error": "Player not found"})
                        continue

                    player["connected"] = True
                    room.sockets[token] = ws

                    if token in room.disconnect_tasks:
                        try:
                            room.disconnect_tasks[token].cancel()
                        except Exception:
                            pass
                        room.disconnect_tasks.pop(token, None)

                    joined_room = room
                    my_name = player.get("name")
                    my_token = token

                await safe_send(ws, {
                    "type": "rejoined",
                    "roomCode": room.code,
                    "mode": room.mode,
                    "players": public_players_state(room),
                    "maxPlayers": max_players(room.mode),
                    "started": bool(room.started and room.match),
                    "startAt": room.match.get("startAt") if room.match else None,
                })

                if room.started and room.match:
                    await safe_send(ws, match_snapshot(room))

                continue

            # ---------------- READY ----------------
            if action == "ready":
                if not joined_room or not my_name:
                    await safe_send(ws, {"type": "error", "error": "Not in a room"})
                    continue

                desired = msg.get("ready")
                if not isinstance(desired, bool):
                    await safe_send(ws, {"type": "error", "error": "ready must be true/false"})
                    continue

                if joined_room.started:
                    await safe_send(ws, {"type": "error", "error": "Match already starting — ready is locked"})
                    continue

                start_now = False

                async with ROOM_LOCK:
                    for p in joined_room.players:
                        if p["name"] == my_name:
                            p["ready"] = desired
                            break

                    state = snapshot(joined_room)

                    if state["allReady"] and not joined_room.started:
                        joined_room.started = True
                        start_now = True

                await broadcast(joined_room, state)

                if start_now:
                    async with ROOM_LOCK:
                        if joined_room.match is None:
                            joined_room.match = build_match(joined_room)
                        if joined_room.match.get("startAt") is None:
                            joined_room.match["startAt"] = time.time() + 3.0

                    await broadcast(joined_room, {
                        "type": "start_match",
                        "roomCode": joined_room.code,
                        "mode": joined_room.mode,
                        "startAt": joined_room.match.get("startAt"),
                        "players": public_players_state(joined_room),
                    })
                    # Point battles start in a round lobby (0-0) before Round 1
                    if joined_room.mode == "point":
                        joined_room.match["betweenRounds"] = True
                        joined_room.match["roundReady"] = {}
                        await broadcast(joined_room, {
                            "type": "round_over",
                            "round": 0,
                            "players": public_players_state(joined_room),
                        })

                continue

            # ---------------- ROUND READY (POINT MODES) ----------------
            if action == "round_ready":
                if not joined_room or not my_name:
                    await safe_send(ws, {"type": "error", "error": "Not in a room"})
                    continue
                if not joined_room.match:
                    await safe_send(ws, {"type": "error", "error": "Match not started"})
                    continue
                if joined_room.match.get("mode") != "point":
                    await safe_send(ws, {"type": "error", "error": "Not a point match"})
                    continue
                if not joined_room.match.get("betweenRounds"):
                    await safe_send(ws, {"type": "error", "error": "Round already in progress"})
                    continue

                joined_room.match["roundReady"][my_name] = True
                all_ready = all(
                    joined_room.match["roundReady"].get(p["name"]) for p in joined_room.players
                )
                await broadcast(joined_room, {
                    "type": "round_ready_state",
                    "players": public_players_state(joined_room),
                })
                if all_ready:
                    joined_room.match["betweenRounds"] = False
                    joined_room.match["roundReady"] = {}
                    # snapshot points at round start
                    for p in joined_room.players:
                        nm = p["name"]
                        joined_room.match["players"][nm]["roundStartPoints"] = int(
                            joined_room.match["players"][nm].get("points", 0)
                        )
                    await broadcast(joined_room, {
                        "type": "round_start",
                        "round": max(int(joined_room.match["players"][p["name"]].get("wordIndex", 0)) for p in joined_room.players) + 1,
                    })
                continue

            # ---------------- LEAVE (EXPLICIT) ----------------
            if action == "leave":
                if not joined_room or not my_name or not my_token:
                    await safe_send(ws, {"type": "error", "error": "Not in a room"})
                    continue

                room_to_broadcast: Room | None = None
                async with ROOM_LOCK:
                    # cancel any pending disconnect task
                    if my_token in joined_room.disconnect_tasks:
                        try:
                            joined_room.disconnect_tasks[my_token].cancel()
                        except Exception:
                            pass
                        joined_room.disconnect_tasks.pop(my_token, None)

                    joined_room.sockets.pop(my_token, None)
                    joined_room.players = [p for p in joined_room.players if p.get("token") != my_token]

                    joined_room.started = False
                    joined_room.match = None
                    for p in joined_room.players:
                        p["ready"] = False

                    if not joined_room.players:
                        ROOMS.pop(joined_room.code, None)
                        room_to_broadcast = None
                    else:
                        room_to_broadcast = joined_room

                if room_to_broadcast:
                    if room_to_broadcast.match and room_to_broadcast.match.get("ended"):
                        return
                    await broadcast(room_to_broadcast, {
                        "type": "player_left",
                        "roomCode": room_to_broadcast.code,
                        "name": my_name or "A player",
                    })
                return

            # ---------------- GUESS (MATCH) ----------------
            if action == "guess":
                if not joined_room or not my_name:
                    await safe_send(ws, {"type": "error", "error": "Not in a room"})
                    continue

                if not joined_room.match:
                    await safe_send(ws, {"type": "error", "error": "Match not started"})
                    continue

                if joined_room.match.get("betweenRounds"):
                    await safe_send(ws, {"type": "guess_result", "ok": False, "error": "Round over — waiting"})
                    continue

                start_at = joined_room.match.get("startAt")
                if isinstance(start_at, (int, float)) and time.time() < start_at:
                    await safe_send(ws, {"type": "guess_result", "ok": False, "error": "Match starting"})
                    continue

                g = (msg.get("guess") or "").strip().lower()
                if len(g) != 5 or (not g.isalpha()):
                    await safe_send(ws, {"type": "guess_result", "ok": False, "error": "Not 5 letters"})
                    continue
                if g not in ALLOWED:
                    await safe_send(ws, {"type": "guess_result", "ok": False, "error": "Not in word list"})
                    continue

                mode = joined_room.match.get("mode")
                st = joined_room.match["players"].get(my_name)
                if not st or st.get("finished"):
                    await safe_send(ws, {"type": "guess_result", "ok": False, "error": "You are finished"})
                    continue

                word_index = int(st.get("wordIndex", 0))
                sequence = joined_room.match.get("sequence", [])
                if word_index >= len(sequence):
                    st["finished"] = True
                    await safe_send(ws, {"type": "guess_result", "ok": False, "error": "No more words"})
                    await broadcast(joined_room, match_snapshot(joined_room))
                    continue

                answer = sequence[word_index]
                result = tilecolor(g, answer)
                st["attemptsThisWord"] = int(st.get("attemptsThisWord", 0)) + 1

                solved_word = (g == answer)
                failed_word = (not solved_word) and (st["attemptsThisWord"] >= 6)

                if mode == "point":
                    pts_table = {1: 7, 2: 5, 3: 4, 4: 3, 5: 2, 6: 1}
                    if solved_word:
                        st["points"] = int(st.get("points", 0)) + int(pts_table.get(st["attemptsThisWord"], 1))
                        st["wins"] = int(st.get("wins", 0)) + 1
                        st["wordIndex"] = word_index + 1
                        st["attemptsThisWord"] = 0
                        st["roundDone"] = True
                    elif failed_word:
                        st["points"] = int(st.get("points", 0)) - 1
                        st["wordIndex"] = word_index + 1
                        st["attemptsThisWord"] = 0
                        st["roundDone"] = True
                else:
                    if solved_word:
                        st["wins"] = int(st.get("wins", 0)) + 1
                        st["wordIndex"] = word_index + 1
                        st["attemptsThisWord"] = 0
                        st["lastWinAt"] = time.time()
                    elif failed_word:
                        st["wordIndex"] = word_index + 1
                        st["attemptsThisWord"] = 0

                if int(st.get("wordIndex", 0)) >= len(sequence):
                    st["finished"] = True
                    if st.get("finishAt") is None:
                        st["finishAt"] = time.time()
                if int(st.get("wins", 0)) >= 3 and st.get("finishAt") is None:
                    st["finishAt"] = time.time()

                await safe_send(ws, {
                    "type": "guess_result",
                    "ok": True,
                    "guess": g,
                    "result": result,
                    "solved": solved_word,
                    "failed": failed_word,
                    "answer": answer if failed_word else None,
                })

                await broadcast(joined_room, match_snapshot(joined_room))

                if mode == "point":
                    # If this player finished the round, and others have not, tell them to wait
                    if st.get("roundDone") and not all(
                        joined_room.match["players"][p["name"]].get("roundDone") for p in joined_room.players
                    ):
                        await safe_send(ws, {
                            "type": "waiting",
                            "message": "Waiting for opponent to finish the round…",
                        })

                    # If all players finished the round, broadcast round_over
                    if all(joined_room.match["players"][p["name"]].get("roundDone") for p in joined_room.players):
                        round_num = max(int(joined_room.match["players"][p["name"]].get("wordIndex", 0)) for p in joined_room.players)
                        # store per-round points
                        for p in joined_room.players:
                            nm = p["name"]
                            stp = joined_room.match["players"][nm]
                            start_pts = int(stp.get("roundStartPoints", 0))
                            earned = int(stp.get("points", 0)) - start_pts
                            idx = max(0, min(2, round_num - 1))
                            stp["roundPoints"][idx] = earned
                        # Do not enter another round lobby after the final round.
                        if round_num < len(sequence):
                            await broadcast(joined_room, {
                                "type": "round_over",
                                "round": round_num,
                                "players": public_players_state(joined_room),
                            })
                            for p in joined_room.players:
                                joined_room.match["players"][p["name"]]["roundDone"] = False
                            joined_room.match["betweenRounds"] = True

                winner: str | None = None
                if mode == "point":
                    if all(int(joined_room.match["players"][p["name"]].get("wordIndex", 0)) >= len(sequence) for p in joined_room.players):
                        best = None
                        tied = False
                        for p in joined_room.players:
                            nm = p["name"]
                            pts = int(joined_room.match["players"][nm].get("points", 0))
                            if best is None or pts > best[1]:
                                best = (nm, pts)
                                tied = False
                            elif best is not None and pts == best[1]:
                                tied = True
                        if best:
                            winner = "Tie" if tied else best[0]
                else:
                    # Sprint mode (duel)
                    winners = []
                    for p in joined_room.players:
                        nm = p["name"]
                        if int(joined_room.match["players"][nm].get("wins", 0)) >= 3:
                            winners.append(nm)

                    if winners:
                        if len(winners) >= 2:
                            # If multiple hit 3 wins at essentially the same time, it's a tie
                            t0 = joined_room.match["players"][winners[0]].get("lastWinAt")
                            t1 = joined_room.match["players"][winners[1]].get("lastWinAt")
                            if isinstance(t0, (int, float)) and isinstance(t1, (int, float)) and abs(t0 - t1) <= 0.5:
                                winner = "Tie"
                            else:
                                # earliest to 3 wins
                                earliest = None
                                for nm in winners:
                                    t = joined_room.match["players"][nm].get("lastWinAt")
                                    if earliest is None or (isinstance(t, (int, float)) and t < earliest[1]):
                                        earliest = (nm, t if isinstance(t, (int, float)) else float("inf"))
                                if earliest:
                                    winner = earliest[0]
                        else:
                            winner = winners[0]
                    else:
                        # If all players finished 10 words, decide by wins, then time
                        if all(int(joined_room.match["players"][p["name"]].get("wordIndex", 0)) >= len(sequence) for p in joined_room.players):
                            best_wins = None
                            contenders = []
                            for p in joined_room.players:
                                nm = p["name"]
                                wins = int(joined_room.match["players"][nm].get("wins", 0))
                                if best_wins is None or wins > best_wins:
                                    best_wins = wins
                                    contenders = [nm]
                                elif wins == best_wins:
                                    contenders.append(nm)

                            if best_wins == 0 and len(contenders) >= 2:
                                winner = "Tie"
                            elif len(contenders) == 1:
                                winner = contenders[0]
                            else:
                                # tie on wins -> faster finish time wins
                                fastest = None
                                for nm in contenders:
                                    t = joined_room.match["players"][nm].get("finishAt")
                                    if fastest is None or (isinstance(t, (int, float)) and t < fastest[1]):
                                        fastest = (nm, t if isinstance(t, (int, float)) else float("inf"))
                                if fastest and fastest[1] != float("inf"):
                                    winner = fastest[0]
                                else:
                                    winner = "Tie"

                if winner:
                    joined_room.match["ended"] = True
                    winner_stats = None
                    loser_stats = None
                    loser_name = None
                    players_stats = {}
                    try:
                        start_at = joined_room.match.get("startAt")
                        now = time.time()
                        for p in joined_room.players:
                            nm = p["name"]
                            stp = joined_room.match["players"].get(nm, {})
                            fin = stp.get("finishAt")
                            dur = None
                            if isinstance(start_at, (int, float)):
                                dur = max(0, (fin if isinstance(fin, (int, float)) else now) - start_at)
                            players_stats[nm] = {
                                "wins": int(stp.get("wins", 0)),
                                "points": int(stp.get("points", 0)),
                                "wordIndex": int(stp.get("wordIndex", 0)),
                                "durationSeconds": dur,
                                "roundPoints": stp.get("roundPoints", [None, None, None]),
                            }

                        if winner != "Tie":
                            stw = joined_room.match["players"].get(winner, {})
                            winner_stats = {
                                "wins": int(stw.get("wins", 0)),
                                "wordIndex": int(stw.get("wordIndex", 0)),
                                "durationSeconds": players_stats.get(winner, {}).get("durationSeconds"),
                            }
                            # loser stats (duel)
                            for p in joined_room.players:
                                nm = p["name"]
                                if nm != winner:
                                    loser_name = nm
                                    stl = joined_room.match["players"].get(nm, {})
                                    loser_stats = {
                                        "wins": int(stl.get("wins", 0)),
                                        "wordIndex": int(stl.get("wordIndex", 0)),
                                        "durationSeconds": players_stats.get(nm, {}).get("durationSeconds"),
                                    }
                                    break
                    except Exception:
                        winner_stats = None

                    await broadcast(joined_room, {
                        "type": "match_over",
                        "roomCode": joined_room.code,
                        "mode": joined_room.mode,
                        "winner": winner,
                        "winnerStats": winner_stats,
                        "loser": loser_name,
                        "loserStats": loser_stats,
                        "playerStats": players_stats,
                        "players": public_players_state(joined_room),
                    })
                else:
                    # If this player finished all words without a winner yet, tell them to wait
                    if st.get("finished"):
                        await safe_send(ws, {
                            "type": "waiting",
                            "message": "Waiting for opponent to finish…",
                        })

                continue

            await safe_send(ws, {"type": "error", "error": "Unknown action"})

    except WebSocketDisconnect:
        pass

    finally:
        if joined_room and my_name and my_token:
            async with ROOM_LOCK:
                for p in joined_room.players:
                    if p.get("token") == my_token:
                        p["connected"] = False
                        break

                joined_room.sockets.pop(my_token, None)
                task = asyncio.create_task(finalize_disconnect(joined_room, my_token, my_name))
                joined_room.disconnect_tasks[my_token] = task
