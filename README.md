# Anime Auction Arena

A real-time anime auction battle game with room-based multiplayer.

## Local development

```bash
npm install
npm start
```

Then open http://localhost:3000

## Deployment

This project is ready to deploy to Render.

1. Push the project to GitHub.
2. Create a new Web Service on Render.
3. Connect the repository.
4. Use the default Node settings or this configuration:
   - Build command: `npm install`
   - Start command: `npm start`
5. Deploy.

The app listens on the PORT environment variable automatically.

### Persistent multiplayer rooms

Create a Supabase Postgres project, copy its Postgres connection string (use the Session pooler connection string if the Render service cannot reach the direct database host), and add it to the Render web service as the secret environment variable `DATABASE_URL`. Include `sslmode=require` in the connection string. The server creates its `game_rooms` table on startup and restores active room state after restarts. Without `DATABASE_URL`, the app runs in local in-memory mode and rooms are lost when the server restarts.

## Multiplayer flow

- One player creates a room.
- The second player joins using the room code.
- The auction room syncs live through Socket.IO. If a player briefly disconnects, their seat is reserved for five minutes while they reconnect.

## Background music

The title screen starts looping background music after the first click. The track is "NPC Theme" by HoliznaCC0, released under CC0 1.0 Universal: https://freemusicarchive.org/music/holiznacc0/chiptunes/npc-theme/. The game streams it from Free Music Archive, and the sound toggle pauses or resumes it.
