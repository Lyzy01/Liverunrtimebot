const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder
} = require('discord.js');
const http = require('http');
const axios = require('axios');

// --- CONFIGURATION ---
const CREATOR_ID = '1366110873248071801';

// Keep-alive server for Render
http.createServer((req, res) => {
    res.write("Bot is awake!");
    res.end();
}).listen(process.env.PORT || 3000);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- FIX #3: Track active intervals to prevent memory leaks ---
const activeIntervals = new Map(); // userId -> intervalId

const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Track a Roblox game live (Creator Only)')
        .addStringOption(option =>
            option.setName('id')
                .setDescription('The Place ID from the URL')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop live tracking (Creator Only)')
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`✅ Logged in as ${client.user.tag}`);
    } catch (e) {
        console.error("Command Registration Error:", e);
    }
});

// --- FIX #1: Helper to fetch with timeout ---
const axiosFetch = (url) =>
    axios.get(url, {
        timeout: 10000,
        headers: { 'Accept': 'application/json' }
    });

// --- FIX #2: Retry wrapper (retries up to 3 times with 2s delay) ---
async function fetchWithRetry(fn, retries = 3, delay = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err?.response?.status;
            console.warn(`⚠️ Attempt ${attempt} failed (HTTP ${status || 'N/A'}): ${err.message}`);

            // Don't retry on 404 (game not found)
            if (status === 404) throw err;

            if (attempt < retries) {
                await new Promise(r => setTimeout(r, delay * attempt)); // exponential backoff
            } else {
                throw err;
            }
        }
    }
}

// --- FIX #1: Use official Roblox APIs + fallback proxy ---
async function getUniverseId(placeId) {
    // Primary: Official Roblox API
    try {
        const res = await fetchWithRetry(() =>
            axiosFetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)
        );
        return { universeId: res.data.universeId, gameName: null };
    } catch {
        // Fallback: roproxy
        try {
            const res = await fetchWithRetry(() =>
                axiosFetch(`https://games.roproxy.com/v1/games/multiget-place-details?placeIds=${placeId}`)
            );
            if (res.data && res.data[0]) {
                return {
                    universeId: res.data[0].universeId,
                    gameName: res.data[0].name
                };
            }
            return null;
        } catch {
            return null;
        }
    }
}

async function getRobloxStats(placeId, startTime) {
    try {
        // Step 1: Get universe ID
        const universeData = await getUniverseId(placeId);
        if (!universeData) return "NOT_FOUND";

        const { universeId } = universeData;

        // Step 2: Fetch game details in parallel (primary endpoint)
        const [gameRes, voteRes, favRes] = await Promise.allSettled([
            fetchWithRetry(() =>
                axiosFetch(`https://games.roproxy.com/v1/games?universeIds=${universeId}`)
            ),
            fetchWithRetry(() =>
                axiosFetch(`https://games.roproxy.com/v1/games/votes?universeIds=${universeId}`)
            ),
            fetchWithRetry(() =>
                axiosFetch(`https://games.roproxy.com/v1/games/${universeId}/favorites/count`)
            )
        ]);

        // Step 3: Check if core game data succeeded
        if (gameRes.status === 'rejected' || !gameRes.value?.data?.data?.[0]) {
            console.error("Game data fetch failed:", gameRes.reason?.message);
            return "BLOCKED";
        }

        const data = gameRes.value.data.data[0];
        const gameName = universeData.gameName || data.name;

        // Step 4: Safely extract votes (might fail, use fallback)
        const votes = voteRes.status === 'fulfilled'
            ? voteRes.value?.data?.data?.[0]
            : null;

        const favCount = favRes.status === 'fulfilled'
            ? favRes.value?.data?.count ?? 0
            : 0;

        return new EmbedBuilder()
            .setTitle(`🎮 ${gameName}`)
            .setURL(`https://www.roblox.com/games/${placeId}`)
            .setColor(data.isPlayable ? 0x00FF00 : 0xFF1100)
            .setThumbnail(
                `https://thumbnails.roproxy.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png`
            )
            .addFields(
                {
                    name: '👍 Likes',
                    value: votes ? votes.upVotes.toLocaleString() : '—',
                    inline: true
                },
                {
                    name: '👎 Dislikes',
                    value: votes ? votes.downVotes.toLocaleString() : '—',
                    inline: true
                },
                {
                    name: '⭐ Favorites',
                    value: favCount.toLocaleString(),
                    inline: true
                },
                {
                    name: '🎮 Active Players',
                    value: (data.playing ?? 0).toLocaleString(),
                    inline: true
                },
                {
                    name: '📡 Status',
                    value: data.isPlayable ? '🟢 Live' : '🔴 Private/Down',
                    inline: true
                },
                {
                    name: '⏱️ Tracking Since',
                    value: `<t:${startTime}:R>`,
                    inline: true
                },
                {
                    name: '📅 Created',
                    value: new Date(data.created).toLocaleDateString(),
                    inline: true
                },
                {
                    name: '👤 Game Creator',
                    value: `**${data.creator.name}** (${data.creator.type})`,
                    inline: false
                }
            )
            .setFooter({ text: '🔄 Updates every 60 seconds  •  BloxRunTime' })
            .setTimestamp();

    } catch (err) {
        console.error("getRobloxStats Error:", err.message);
        // Differentiate error types
        const status = err?.response?.status;
        if (status === 404) return "NOT_FOUND";
        return "BLOCKED";
    }
}

// --- INTERACTION HANDLER ---
client.on('interactionCreate', async i => {
    if (!i.isChatInputCommand()) return;

    // Only allow creator
    if (i.user.id !== CREATOR_ID) {
        return i.reply({ content: '❌ This command is restricted to the bot creator.', ephemeral: true });
    }

    // /stop command
    if (i.commandName === 'stop') {
        const existing = activeIntervals.get(i.user.id);
        if (existing) {
            clearInterval(existing);
            activeIntervals.delete(i.user.id);
            return i.reply({ content: '⏹️ Live tracking stopped.', ephemeral: true });
        }
        return i.reply({ content: '⚠️ No active tracking session found.', ephemeral: true });
    }

    // /start command
    if (i.commandName === 'start') {
        const placeId = i.options.getString('id');

        // Validate that placeId is numeric
        if (!/^\d+$/.test(placeId)) {
            return i.reply({ content: '❌ Invalid Place ID. It should be a number only (e.g. `6872265039`).', ephemeral: true });
        }

        // Stop any existing interval for this user
        const existing = activeIntervals.get(i.user.id);
        if (existing) clearInterval(existing);

        const startTime = Math.floor(Date.now() / 1000);
        await i.deferReply();

        const refresh = async () => {
            try {
                const result = await getRobloxStats(placeId, startTime);
                if (result instanceof EmbedBuilder) {
                    await i.editReply({ content: '', embeds: [result] });
                } else if (result === "NOT_FOUND") {
                    await i.editReply({
                        content: '❌ Game not found. Please check the Place ID and try again.',
                        embeds: []
                    });
                    // Stop tracking if game doesn't exist
                    const interval = activeIntervals.get(i.user.id);
                    if (interval) {
                        clearInterval(interval);
                        activeIntervals.delete(i.user.id);
                    }
                } else {
                    // BLOCKED — don't stop, just show warning and retry next tick
                    await i.editReply({
                        content: '⚠️ Roblox API is temporarily unavailable. Retrying next update...',
                        embeds: []
                    });
                }
            } catch (err) {
                console.error("Refresh error:", err.message);
            }
        };

        // Run immediately, then every 60s
        await refresh();
        const intervalId = setInterval(refresh, 60000);
        activeIntervals.set(i.user.id, intervalId);
    }
});

// --- PREFIX COMMAND: !update ---
client.on('messageCreate', async m => {
    if (m.author.bot || m.author.id !== CREATOR_ID) return;

    if (m.content.startsWith('!update')) {
        const placeId = m.content.split(' ')[1];

        if (!placeId || !/^\d+$/.test(placeId)) {
            return m.reply('❌ Usage: `!update <placeId>` — Place ID must be a number.');
        }

        const startTime = Math.floor(Date.now() / 1000);
        const loadingMsg = await m.reply('🔄 Fetching game data...');
        const result = await getRobloxStats(placeId, startTime);

        if (result instanceof EmbedBuilder) {
            await loadingMsg.edit({ content: '', embeds: [result] });
        } else if (result === "NOT_FOUND") {
            await loadingMsg.edit('❌ Game not found. Check the Place ID.');
        } else {
            await loadingMsg.edit('❌ Roblox API is currently unavailable. Try again in a moment.');
        }
    }

    if (m.content === '!stop') {
        const interval = activeIntervals.get(m.author.id);
        if (interval) {
            clearInterval(interval);
            activeIntervals.delete(m.author.id);
            m.reply('⏹️ Live tracking stopped.');
        } else {
            m.reply('⚠️ No active tracking to stop.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
