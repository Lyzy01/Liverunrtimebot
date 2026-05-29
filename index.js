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

// Track active intervals: key = `${userId}_${channelId}` -> intervalId
const activeIntervals = new Map();

// Track the pushed message per channel so we can edit it
// key = channelId -> messageId
const pushedMessages = new Map();

// Store the last used placeId per user
const lastPlaceId = new Map();

const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Track a Roblox game live in this channel (Creator Only)')
        .addStringOption(option =>
            option.setName('id')
                .setDescription('The Place ID from the URL')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop live tracking in this channel (Creator Only)'),
    new SlashCommandBuilder()
        .setName('dmstart')
        .setDescription('List all servers and channels the bot is in (Creator Only, only you see this)'),
    new SlashCommandBuilder()
        .setName('dmstartpush')
        .setDescription('Silently push live tracker to a specific channel (Creator Only)')
        .addStringOption(option =>
            option.setName('server_id')
                .setDescription('The Server (Guild) ID')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('channel_id')
                .setDescription('The Channel ID')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('dmstop')
        .setDescription('Stop a pushed tracker in a specific channel (Creator Only)')
        .addStringOption(option =>
            option.setName('channel_id')
                .setDescription('The Channel ID to stop tracking in')
                .setRequired(true)
        ),
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

// ---- API HELPERS ----
const axiosFetch = (url) =>
    axios.get(url, { timeout: 10000, headers: { 'Accept': 'application/json' } });

async function fetchWithFallback(path) {
    const proxies = [
        `https://${path.replace('roblox.com', 'roproxy.com')}`,
        `https://${path.replace('roblox.com', 'rotunnel.com')}`,
    ];
    for (const url of proxies) {
        try {
            return await axiosFetch(url);
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
            if (res.data?.[0]) return { universeId: res.data[0].universeId, gameName: res.data[0].name };
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
            fetchWithFallback(`games.roblox.com/v1/games/${universeId}/votes`),
            fetchWithFallback(`games.roblox.com/v1/games/${universeId}/favorites/count`),
            fetchWithFallback(`thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png&isCircular=false`)
        ]);

        if (gameRes.status === 'rejected' || !gameRes.value?.data?.data?.[0]) return "BLOCKED";

        const data      = gameRes.value.data.data[0];
        const gameName  = universeData.gameName || data.name;
        const votesRaw  = voteRes.status  === 'fulfilled' ? voteRes.value?.data  : null;
        const upVotes   = votesRaw?.upVotes   ?? null;
        const downVotes = votesRaw?.downVotes ?? null;
        const favData   = favRes.status   === 'fulfilled' ? favRes.value?.data   : null;
        const favCount  = favData?.favoritesCount ?? favData?.count ?? null;
        const thumbUrl  = thumbRes.status === 'fulfilled' ? thumbRes.value?.data?.data?.[0]?.imageUrl ?? null : null;

        const totalVotes = (upVotes ?? 0) + (downVotes ?? 0);
        const likeRatio  = upVotes != null && totalVotes > 0
            ? ((upVotes / totalVotes) * 100).toFixed(1) : null;

        const visits  = data.visits  ?? 0;
        const playing = data.playing ?? 0;
        const isLive  = data.isPlayable || playing > 0;

        const embed = new EmbedBuilder()
            .setTitle(`🎮 ${gameName}`)
            .setURL(`https://www.roblox.com/games/${placeId}`)
            .setColor(isLive ? 0x00FF00 : 0xFF1100)
            .addFields(
                { name: '👍 Likes',    value: upVotes   != null ? `${fmt(upVotes)}${likeRatio ? ` · **${likeRatio}%**` : ''}` : 'N/A', inline: true },
                { name: '👎 Dislikes', value: downVotes != null ? fmt(downVotes) : 'N/A', inline: true },
                { name: '⭐ Favorites', value: favCount  != null ? fmt(favCount)  : 'N/A', inline: true },
                { name: '🕹️ Visits',   value: fmt(visits),  inline: true },
                { name: '👥 Active Players', value: fmt(playing), inline: true },
                { name: '📡 Status',   value: isLive ? '🟢 Live' : '🔴 Private/Down', inline: true },
                { name: '⏱️ Tracking Since', value: `<t:${startTime}:R>`, inline: true },
                { name: '📅 Created',  value: new Date(data.created).toLocaleDateString(), inline: true },
                { name: '👤 Game Creator', value: `**${data.creator.name}** (${data.creator.type})`, inline: false }
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

// ---- START TRACKING IN A SPECIFIC CHANNEL ----
async function startTrackingInChannel(channel, placeId, startTime, intervalKey) {
    // Stop existing interval on this channel if any
    if (activeIntervals.has(intervalKey)) {
        clearInterval(activeIntervals.get(intervalKey));
        activeIntervals.delete(intervalKey);
    }

    // Initial fetch
    const result = await getRobloxStats(placeId, startTime);
    if (result === "NOT_FOUND") return { success: false, reason: "Game not found." };
    if (result === "BLOCKED")   return { success: false, reason: "Roblox API unavailable." };

    // Send the message to the channel
    const msg = await channel.send({ embeds: [result] });
    pushedMessages.set(channel.id, msg.id);

    // Start interval to edit that message every 60s
    const intervalId = setInterval(async () => {
        try {
            const updated = await getRobloxStats(placeId, startTime);
            const fetchedMsg = await channel.messages.fetch(msg.id).catch(() => null);
            if (!fetchedMsg) {
                clearInterval(activeIntervals.get(intervalKey));
                activeIntervals.delete(intervalKey);
                return;
            }
            if (updated instanceof EmbedBuilder) {
                await fetchedMsg.edit({ embeds: [updated] });
            }
        } catch (err) {
            console.error("Push interval error:", err.message);
        }
    }, 60000);

    activeIntervals.set(intervalKey, intervalId);
    return { success: true };
}

// ---- INTERACTION HANDLER ----
client.on('interactionCreate', async i => {
    if (!i.isChatInputCommand()) return;

    // Only creator can use these
    if (i.user.id !== CREATOR_ID) {
        return i.reply({ content: '❌ This command is restricted to the bot creator.', ephemeral: true });
    }

    // ── /start ───────────────────────────────────────────────
    if (i.commandName === 'start') {
        const placeId = i.options.getString('id');
        if (!/^\d+$/.test(placeId)) {
            return i.reply({ content: '❌ Invalid Place ID. Numbers only.', ephemeral: true });
        }

        lastPlaceId.set(i.user.id, placeId);
        const intervalKey = `${i.user.id}_${i.channelId}`;
        const existing = activeIntervals.get(intervalKey);
        if (existing) clearInterval(existing);

        const startTime = Math.floor(Date.now() / 1000);
        await i.deferReply();

        const refresh = async () => {
            try {
                const result = await getRobloxStats(placeId, startTime);
                if (result instanceof EmbedBuilder) {
                    await i.editReply({ content: '', embeds: [result] });
                } else if (result === "NOT_FOUND") {
                    await i.editReply({ content: '❌ Game not found.', embeds: [] });
                    clearInterval(activeIntervals.get(intervalKey));
                    activeIntervals.delete(intervalKey);
                } else {
                    await i.editReply({ content: '⚠️ Roblox API temporarily unavailable. Retrying...', embeds: [] });
                }
            } catch (err) { console.error("Refresh error:", err.message); }
        };

        await refresh();
        const intervalId = setInterval(refresh, 60000);
        activeIntervals.set(intervalKey, intervalId);
    }

    // ── /stop ────────────────────────────────────────────────
    if (i.commandName === 'stop') {
        const intervalKey = `${i.user.id}_${i.channelId}`;
        const existing = activeIntervals.get(intervalKey);
        if (existing) {
            clearInterval(existing);
            activeIntervals.delete(intervalKey);
            return i.reply({ content: '⏹️ Live tracking stopped.', ephemeral: true });
        }
        return i.reply({ content: '⚠️ No active tracking in this channel.', ephemeral: true });
    }

    // ── /dmstart ─────────────────────────────────────────────
    if (i.commandName === 'dmstart') {
        await i.deferReply({ ephemeral: true });

        const guilds = client.guilds.cache;
        if (guilds.size === 0) {
            return i.editReply('❌ Bot is not in any servers.');
        }

        let output = `📋 **Bot is in ${guilds.size} server(s):**\n\n`;

        for (const [, guild] of guilds) {
            output += `🏠 **${guild.name}** \`(${guild.id})\`\n`;

            // Get text channels the bot can send messages in
            const textChannels = guild.channels.cache
                .filter(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages'))
                .sort((a, b) => a.position - b.position);

            if (textChannels.size === 0) {
                output += `  ⚠️ No accessible text channels\n`;
            } else {
                for (const [, ch] of textChannels) {
                    output += `  📢 **#${ch.name}** \`${ch.id}\`\n`;
                }
            }
            output += '\n';

            // Discord has a 2000 char limit — split if needed
            if (output.length > 1800) {
                await i.editReply(output);
                output = '*(continued...)*\n\n';
            }
        }

        const lastPlaceUsed = lastPlaceId.get(i.user.id);
        output += `\n💡 **Usage:** \`/dmstartpush server_id: [ID] channel_id: [ID]\``;
        if (lastPlaceUsed) output += `\n🎮 **Last Place ID used:** \`${lastPlaceUsed}\``;

        return i.editReply(output);
    }

    // ── /dmstartpush ─────────────────────────────────────────
    if (i.commandName === 'dmstartpush') {
        const serverId  = i.options.getString('server_id');
        const channelId = i.options.getString('channel_id');

        // Get last used place ID
        const placeId = lastPlaceId.get(i.user.id);
        if (!placeId) {
            return i.reply({
                content: '❌ No Place ID found. Use `/start [id]` first to set a game, then use `/dmstartpush`.',
                ephemeral: true
            });
        }

        await i.deferReply({ ephemeral: true });

        // Find the guild
        const guild = client.guilds.cache.get(serverId);
        if (!guild) {
            return i.editReply(`❌ Server not found. Make sure the bot is in that server.\nServer ID: \`${serverId}\``);
        }

        // Find the channel
        const channel = guild.channels.cache.get(channelId);
        if (!channel || !channel.isTextBased()) {
            return i.editReply(`❌ Channel not found or not a text channel.\nChannel ID: \`${channelId}\``);
        }

        // Check bot permissions
        const perms = channel.permissionsFor(guild.members.me);
        if (!perms?.has('SendMessages') || !perms?.has('EmbedLinks')) {
            return i.editReply(`❌ I don't have permission to send messages in <#${channelId}>. Please check my permissions.`);
        }

        const startTime = Math.floor(Date.now() / 1000);
        const intervalKey = `push_${channelId}`;

        const { success, reason } = await startTrackingInChannel(channel, placeId, startTime, intervalKey);

        if (success) {
            return i.editReply(`✅ Live tracker for Place ID \`${placeId}\` is now running in **#${channel.name}** (${guild.name})!\n🔄 Updating every 60 seconds silently.`);
        } else {
            return i.editReply(`❌ Failed to start tracker: ${reason}`);
        }
    }

    // ── /dmstop ──────────────────────────────────────────────
    if (i.commandName === 'dmstop') {
        const channelId  = i.options.getString('channel_id');
        const intervalKey = `push_${channelId}`;
        const existing   = activeIntervals.get(intervalKey);

        if (existing) {
            clearInterval(existing);
            activeIntervals.delete(intervalKey);
            pushedMessages.delete(channelId);
            return i.reply({ content: `⏹️ Stopped pushed tracker in channel \`${channelId}\`.`, ephemeral: true });
        }
        return i.reply({ content: `⚠️ No active pushed tracker found for channel \`${channelId}\`.`, ephemeral: true });
    }
});

// ---- PREFIX COMMANDS ----
client.on('messageCreate', async m => {
    if (m.author.bot || m.author.id !== CREATOR_ID) return;

    if (m.content.startsWith('!update')) {
        const placeId = m.content.split(' ')[1];
        if (!placeId || !/^\d+$/.test(placeId)) {
            return m.reply('❌ Usage: `!update <placeId>`');
        }
        lastPlaceId.set(m.author.id, placeId);
        const startTime = Math.floor(Date.now() / 1000);
        const loadingMsg = await m.reply('🔄 Fetching game data...');
        const result = await getRobloxStats(placeId, startTime);
        if (result instanceof EmbedBuilder) {
            await loadingMsg.edit({ content: '', embeds: [result] });
        } else if (result === "NOT_FOUND") {
            await loadingMsg.edit('❌ Game not found.');
        } else {
            await loadingMsg.edit('❌ Roblox API unavailable. Try again.');
        }
    }

    if (m.content === '!stop') {
        const intervalKey = `${m.author.id}_${m.channelId}`;
        const interval = activeIntervals.get(intervalKey);
        if (interval) {
            clearInterval(interval);
            activeIntervals.delete(intervalKey);
            m.reply('⏹️ Live tracking stopped.');
        } else {
            m.reply('⚠️ No active tracking to stop.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
