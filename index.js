const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');
const axios = require('axios');

// --- CONFIGURATION ---
const CREATOR_ID = '1366110873248071801'; 

// Keep-alive server for Render
http.createServer((req, res) => { res.write("Bot is awake!"); res.end(); }).listen(process.env.PORT || 3000);

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Track a Roblox game live (Creator Only)')
        .addStringOption(option => option.setName('id').setDescription('The Place ID from the URL').setRequired(true))
].map(command => command.toJSON());

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`✅ Logged in as ${client.user.tag}`);
    } catch (e) { console.error("Command Error:", e); }
});

async function getRobloxStats(placeId, startTime) {
    try {
        // USING ROPROXY INSTEAD OF ROBLOX TO BYPASS BLOCKS
        const idRes = await axios.get(`https://games.roproxy.com/v1/games/multiget-place-details?placeIds=${placeId}`);
        if (!idRes.data || !idRes.data[0]) return "NOT_FOUND";
        
        const universeId = idRes.data[0].universeId;
        const gameName = idRes.data[0].name;

        const [gameRes, voteRes, favRes] = await Promise.all([
            axios.get(`https://games.roproxy.com/v1/games?universeIds=${universeId}`),
            axios.get(`https://games.roproxy.com/v1/games/votes?universeIds=${universeId}`),
            axios.get(`https://games.roproxy.com/v1/games/${universeId}/favorites/count`)
        ]);

        const data = gameRes.data.data[0];
        const votes = voteRes.data.data[0];

        return new EmbedBuilder()
            .setTitle(`🎮 Game: ${gameName}`)
            .setURL(`https://www.roblox.com/games/${placeId}`)
            .setColor(data.isPlayable ? "#00FF00" : "#FF1100")
            .setThumbnail(`https://www.roblox.com/asset-thumbnail/image?assetId=${placeId}&width=420&height=420&format=png`)
            .addFields(
                { name: '👍 Likes', value: votes.upVotes.toLocaleString(), inline: true },
                { name: '👎 Dislikes', value: votes.downVotes.toLocaleString(), inline: true },
                { name: '⭐ Favorites', value: favRes.data.count.toLocaleString(), inline: true },
                { name: '📡 Status', value: data.isPlayable ? "🟢 Live" : "🔴 Private/Down", inline: true },
                { name: '⏱️ Live Time', value: `Tracking started <t:${startTime}:R>`, inline: true },
                { name: '📅 Date Created', value: new Date(data.created).toLocaleDateString(), inline: true },
                { name: '👤 Game Creator', value: `By: **${data.creator.name}** (${data.creator.type})`, inline: false }
            )
            .setFooter({ text: "Updating every 60 seconds" })
            .setTimestamp();
    } catch (err) {
        console.error("Proxy API Error:", err.message);
        return "BLOCKED";
    }
}

client.on('interactionCreate', async i => {
    if (!i.isChatInputCommand() || i.user.id !== CREATOR_ID) return;

    const placeId = i.options.getString('id');
    const startTime = Math.floor(Date.now() / 1000); 
    
    await i.deferReply();

    const refresh = async () => {
        const result = await getRobloxStats(placeId, startTime);
        if (result instanceof EmbedBuilder) {
            await i.editReply({ content: '', embeds: [result] });
        } else {
            await i.editReply("❌ Error: Game not found or Proxy is currently down.");
        }
    };

    refresh();
    setInterval(refresh, 60000); 
});

client.on('messageCreate', async m => {
    if (m.author.id !== CREATOR_ID) return;
    if (m.content.startsWith('!update')) {
        const placeId = m.content.split(' ')[1];
        if (!placeId) return m.reply("❌ Use: `!update [placeId]`");
        
        const startTime = Math.floor(Date.now() / 1000);
        const result = await getRobloxStats(placeId, startTime);
        if (result instanceof EmbedBuilder) m.reply({ embeds: [result] });
        else m.reply("❌ Error fetching data.");
    }
});

client.login(process.env.DISCORD_TOKEN);
