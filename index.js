const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');
const axios = require('axios');

// --- YOUR CONFIG ---
const CREATOR_ID = '1120259838027735160'; 

http.createServer((req, res) => { res.write("Bot is running!"); res.end(); }).listen(process.env.PORT || 3000);

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Track a Roblox game live')
        .addStringOption(option => option.setName('id').setDescription('The Place ID from the URL').setRequired(true))
].map(command => command.toJSON());

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Bot Online');
    } catch (e) { console.error("Command Error:", e); }
});

async function getRobloxStats(placeId) {
    try {
        // STEP 1: Get Universe ID using a more stable public endpoint
        const placeDetails = await axios.get(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`);
        
        if (!placeDetails.data || placeDetails.data.length === 0) return "ID_NOT_FOUND";
        
        const universeId = placeDetails.data[0].universeId;
        const name = placeDetails.data[0].name;

        // STEP 2: Fetch Votes, Favorites, and Full Game Data in one go
        const [gameRes, voteRes, favRes] = await Promise.all([
            axios.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
            axios.get(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`),
            axios.get(`https://games.roblox.com/v1/games/${universeId}/favorites/count`)
        ]);

        const data = gameRes.data.data[0];
        const votes = voteRes.data.data[0];

        return new EmbedBuilder()
            .setTitle(`🎮 Game: ${name}`)
            .setURL(`https://www.roblox.com/games/${placeId}`)
            .setColor(data.isPlayable ? "#00FF00" : "#FF0000")
            .setThumbnail(`https://www.roblox.com/asset-thumbnail/image?assetId=${placeId}&width=420&height=420&format=png`)
            .addFields(
                { name: '👤 Creator', value: data.creator.name, inline: true },
                { name: '📡 Status', value: data.isPlayable ? "🟢 Live" : "🔴 Private/Down", inline: true },
                { name: '👥 Players', value: data.playing.toLocaleString(), inline: true },
                { name: '👍 Likes', value: votes.upVotes.toLocaleString(), inline: true },
                { name: '👎 Dislikes', value: votes.downVotes.toLocaleString(), inline: true },
                { name: '⭐ Favorites', value: favRes.data.count.toLocaleString(), inline: true },
                { name: '📈 Total Visits', value: data.visits.toLocaleString(), inline: true },
                { name: '📅 Created', value: new Date(data.created).toLocaleDateString(), inline: true }
            )
            .setFooter({ text: "Updating every 60s" })
            .setTimestamp();
    } catch (err) {
        console.error("Roblox API Error:", err.message);
        return "API_ERROR";
    }
}

// SLASH COMMAND HANDLE
client.on('interactionCreate', async i => {
    if (!i.isChatInputCommand() || i.user.id !== CREATOR_ID) return;
    const placeId = i.options.getString('id');
    
    await i.reply(`🛰️ Connecting to Roblox for ID: ${placeId}...`);

    const refresh = async () => {
        const result = await getRobloxStats(placeId);
        if (result instanceof EmbedBuilder) {
            await i.editReply({ content: '', embeds: [result] });
        } else if (result === "ID_NOT_FOUND") {
            await i.editReply("❌ Error: Couldn't find that game. Is the ID correct?");
        } else {
            await i.editReply("❌ Error: Roblox API is currently blocking the request. Try again later.");
        }
    };

    refresh();
    setInterval(refresh, 60000);
});

// TEXT COMMAND HANDLE
client.on('messageCreate', async m => {
    if (m.author.bot || m.author.id !== CREATOR_ID) return;
    if (m.content.startsWith('!update')) {
        const placeId = m.content.split(' ')[1];
        if (!placeId) return m.reply("❌ Use: `!update [placeId]`");
        
        const result = await getRobloxStats(placeId);
        if (result instanceof EmbedBuilder) {
            m.reply({ embeds: [result] });
        } else {
            m.reply("❌ Failed to fetch data. Check the ID.");
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
