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

## Multiplayer flow

- One player creates a room.
- The second player joins using the room code.
- The auction room syncs live through Socket.IO.

## Background music

The title screen starts looping background music after the first click. The track is "NPC Theme" by HoliznaCC0, released under CC0 1.0 Universal: https://freemusicarchive.org/music/holiznacc0/chiptunes/npc-theme/. The game streams it from Free Music Archive, and the sound toggle pauses or resumes it.
