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

const activeIntervals = new Map();

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

const axiosFetch = (url) =>
    axios.get(url, { timeout: 10000, headers: { 'Accept': 'application/json' } });

async function fetchWithRetry(fn, retries = 3, delay = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err?.response?.status;
            console.warn(`⚠️ Attempt ${attempt} failed (HTTP ${status || 'N/A'}): ${err.message}`);
            if (status === 404) throw err;
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, delay * attempt));
            } else {
                throw err;
            }
        }
    }
}

// Try URL with roproxy first, fallback to rotunnel
async function fetchWithFallback(path) {
    const proxies = [
        `https://${path.replace('roblox.com', 'roproxy.com')}`,
        `https://${path.replace('roblox.com', 'rotunnel.com')}`,
        `https://${path}` // direct as last resort
    ];
    for (const url of proxies) {
        try {
            const res = await axiosFetch(url);
            return res;
        } catch (err) {
            console.warn(`Proxy failed (${url}): ${err.message}`);
        }
    }
    throw new Error(`All proxies failed for: ${path}`);
}

async function getUniverseId(placeId) {
    try {
        const res = await fetchWithFallback(`apis.roblox.com/universes/v1/places/${placeId}/universe`);
        return { universeId: res.data.universeId, gameName: null };
    } catch {
        try {
            const res = await fetchWithFallback(`games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`);
            if (res.data && res.data[0]) {
                return { universeId: res.data[0].universeId, gameName: res.data[0].name };
            }
        } catch {}
        return null;
    }
}

function fmt(n) {
    if (n == null) return 'N/A';
    const full = n.toLocaleString();
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B (${full})`;
    if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M (${full})`;
    if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K (${full})`;
    return full;
}

async function getRobloxStats(placeId, startTime) {
    try {
        const universeData = await getUniverseId(placeId);
        if (!universeData) return "NOT_FOUND";

        const { universeId } = universeData;

        const [gameRes, voteRes, favRes, thumbRes] = await Promise.allSettled([
            fetchWithFallback(`games.roblox.com/v1/games?universeIds=${universeId}`),
            // Correct votes endpoint: /v1/games/{universeId}/votes
            fetchWithFallback(`games.roblox.com/v1/games/${universeId}/votes`),
            // Correct favorites endpoint: /v1/games/{universeId}/favorites/count
            fetchWithFallback(`games.roblox.com/v1/games/${universeId}/favorites/count`),
            fetchWithFallback(`thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png&isCircular=false`)
        ]);

        if (gameRes.status === 'rejected' || !gameRes.value?.data?.data?.[0]) {
            console.error("Game data fetch failed:", gameRes.reason?.message);
            return "BLOCKED";
        }

        const data = gameRes.value.data.data[0];
        const gameName = universeData.gameName || data.name;

        // votes returns { upVotes, downVotes } directly
        const votesRaw = voteRes.status === 'fulfilled' ? voteRes.value?.data : null;
        const upVotes   = votesRaw?.upVotes   ?? null;
        const downVotes = votesRaw?.downVotes ?? null;

        // favorites returns { favoritesCount: N }  OR  { count: N } depending on endpoint
        const favData = favRes.status === 'fulfilled' ? favRes.value?.data : null;
        const favCount = favData?.favoritesCount ?? favData?.count ?? null;

        const thumbUrl = thumbRes.status === 'fulfilled'
            ? thumbRes.value?.data?.data?.[0]?.imageUrl ?? null
            : null;

        // Like ratio
        const totalVotes = (upVotes ?? 0) + (downVotes ?? 0);
        const likeRatio = upVotes != null && totalVotes > 0
            ? ((upVotes / totalVotes) * 100).toFixed(1)
            : null;

        const visits  = data.visits  ?? 0;
        const playing = data.playing ?? 0;

        // FIX: isPlayable can be false even when live on some games.
        // Use playing > 0 as a more reliable "live" signal
        const isLive = data.isPlayable || playing > 0;

        const embed = new EmbedBuilder()
            .setTitle(`🎮 ${gameName}`)
            .setURL(`https://www.roblox.com/games/${placeId}`)
            .setColor(isLive ? 0x00FF00 : 0xFF1100)
            .addFields(
                {
                    name: '👍 Likes',
                    value: upVotes != null
                        ? `${fmt(upVotes)}${likeRatio ? ` · **${likeRatio}%**` : ''}`
                        : 'N/A',
                    inline: true
                },
                {
                    name: '👎 Dislikes',
                    value: downVotes != null ? fmt(downVotes) : 'N/A',
                    inline: true
                },
                {
                    name: '⭐ Favorites',
                    value: favCount != null ? fmt(favCount) : 'N/A',
                    inline: true
                },
                {
                    name: '🕹️ Visits',
                    value: fmt(visits),
                    inline: true
                },
                {
                    name: '👥 Active Players',
                    value: fmt(playing),
                    inline: true
                },
                {
                    name: '📡 Status',
                    value: isLive ? '🟢 Live' : '🔴 Private/Down',
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

        if (thumbUrl) embed.setImage(thumbUrl);

        return embed;

    } catch (err) {
        console.error("getRobloxStats Error:", err.message);
        if (err?.response?.status === 404) return "NOT_FOUND";
        return "BLOCKED";
    }
}

client.on('interactionCreate', async i => {
    if (!i.isChatInputCommand()) return;

    if (i.user.id !== CREATOR_ID) {
        return i.reply({ content: '❌ This command is restricted to the bot creator.', ephemeral: true });
    }

    if (i.commandName === 'stop') {
        const existing = activeIntervals.get(i.user.id);
        if (existing) {
            clearInterval(existing);
            activeIntervals.delete(i.user.id);
            return i.reply({ content: '⏹️ Live tracking stopped.', ephemeral: true });
        }
        return i.reply({ content: '⚠️ No active tracking session found.', ephemeral: true });
    }

    if (i.commandName === 'start') {
        const placeId = i.options.getString('id');

        if (!/^\d+$/.test(placeId)) {
            return i.reply({ content: '❌ Invalid Place ID. Must be numbers only (e.g. `6872265039`).', ephemeral: true });
        }

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
                    await i.editReply({ content: '❌ Game not found. Check the Place ID.', embeds: [] });
                    const interval = activeIntervals.get(i.user.id);
                    if (interval) { clearInterval(interval); activeIntervals.delete(i.user.id); }
                } else {
                    await i.editReply({ content: '⚠️ Roblox API temporarily unavailable. Retrying next update...', embeds: [] });
                }
            } catch (err) {
                console.error("Refresh error:", err.message);
            }
        };

        await refresh();
        const intervalId = setInterval(refresh, 60000);
        activeIntervals.set(i.user.id, intervalId);
    }
});

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
