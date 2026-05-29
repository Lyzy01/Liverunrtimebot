const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');
const axios = require('axios');

// 1. KEEP-ALIVE SERVER
http.createServer((req, res) => {
    res.write("Bot is running!");
    res.end();
}).listen(process.env.PORT || 3000);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 2. SLASH COMMAND WITH INPUT
const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Track a Roblox game')
        .addStringOption(option => 
            option.setName('gameid')
            .setDescription('The Universe ID or Start Place ID of the game')
            .setRequired(true))
].map(command => command.toJSON());

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Commands Registered');
    } catch (error) { console.error(error); }
});

// 3. THE LIVE TRACKER LOGIC
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'start') {
        const gameId = interaction.options.getString('gameid');
        const startTime = `<t:${Math.floor(Date.now() / 1000)}:R>`; // Relative time for Live Time
        
        await interaction.reply(`🛰️ Connecting to Roblox API for ID: ${gameId}...`);

        const updateFeed = async () => {
            try {
                // Fetch Game Details (Name, Creator, Status)
                const gameRes = await axios.get(`https://games.roblox.com/v1/games?universeIds=${gameId}`);
                const data = gameRes.data.data[0];

                if (!data) return;

                // Fetch Votes (Likes/Dislikes)
                const voteRes = await axios.get(`https://games.roblox.com/v1/games/votes?universeIds=${gameId}`);
                const votes = voteRes.data.data[0];

                // Fetch Favorites
                const favRes = await axios.get(`https://games.roblox.com/v1/games/${gameId}/favorites/count`);
                const favorites = favRes.data.count;

                const liveEmbed = new EmbedBuilder()
                    .setTitle(`🎮 Game: ${data.name}`)
                    .setURL(`https://www.roblox.com/games/${data.rootPlaceId}`)
                    .setColor(data.isPlayable ? "#00FF00" : "#FF0000")
                    .addFields(
                        { name: '👍 Likes', value: `${votes.upVotes.toLocaleString()}`, inline: true },
                        { name: '👎 Dislikes', value: `${votes.downVotes.toLocaleString()}`, inline: true },
                        { name: '⭐ Favorites', value: `${favorites.toLocaleString()}`, inline: true },
                        { name: '📡 Status', value: data.isPlayable ? "🟢 Live" : "🔴 Private/Down", inline: true },
                        { name: '👤 Game Creator', value: `By: **${data.creator.name}** (${data.creator.type})`, inline: true },
                        { name: '📅 Date Created', value: new Date(data.created).toLocaleDateString(), inline: true },
                        { name: '⏱️ Live Time', value: `Tracking started ${startTime}`, inline: false }
                    )
                    .setFooter({ text: "Updating every 60 seconds" })
                    .setTimestamp();

                await interaction.editReply({ content: '', embeds: [liveEmbed] });
            } catch (err) {
                console.error("Roblox API Error:", err);
            }
        };

        // Run immediately and then every 60 seconds
        updateFeed();
        setInterval(updateFeed, 60000); 
    }
});

client.login(process.env.DISCORD_TOKEN);
