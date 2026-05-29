const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');
const axios = require('axios');

// --- CONFIGURATION ---
const CREATOR_ID = '1120259838027735160'; // Your ID from the screenshot

// 1. KEEP-ALIVE SERVER (For Render/UptimeRobot)
http.createServer((req, res) => {
    res.write("Bot is running!");
    res.end();
}).listen(process.env.PORT || 3000);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 2. SLASH COMMAND
const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Track a Roblox game (Works with Place ID!)')
        .addStringOption(option => 
            option.setName('id')
            .setDescription('Paste the ID from the game link here')
            .setRequired(true))
].map(command => command.toJSON());

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Bot is online and commands are ready!');
    } catch (error) { console.error(error); }
});

// 3. THE LOGIC
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'start') {
        // Security check
        if (interaction.user.id !== CREATOR_ID) {
            return interaction.reply({ content: "❌ Only the bot creator can use this!", ephemeral: true });
        }

        const inputId = interaction.options.getString('id');
        await interaction.reply(`🛰️ Processing Game ID: ${inputId}...`);

        const updateFeed = async () => {
            try {
                // STEP 1: Automatically find UniverseID from PlaceID
                const idUrl = `https://apis.roblox.com/universes/v1/places/${inputId}/universe`;
                const idRes = await axios.get(idUrl);
                const universeId = idRes.data.universeId;

                // STEP 2: Fetch all the game details
                const [gameRes, voteRes, favRes] = await Promise.all([
                    axios.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
                    axios.get(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`),
                    axios.get(`https://games.roblox.com/v1/games/${universeId}/favorites/count`)
                ]);

                const data = gameRes.data.data[0];
                const votes = voteRes.data.data[0];

                if (!data) return;

                const liveEmbed = new EmbedBuilder()
                    .setTitle(`🎮 Game: ${data.name}`)
                    .setURL(`https://www.roblox.com/games/${inputId}`)
                    .setColor(data.isPlayable ? "#00FF00" : "#FF1100")
                    .setThumbnail(`https://www.roblox.com/asset-thumbnail/image?assetId=${inputId}&width=420&height=420&format=png`)
                    .addFields(
                        { name: '👤 Creator', value: `By: **${data.creator.name}**`, inline: true },
                        { name: '📡 Status', value: data.isPlayable ? "🟢 Live" : "🔴 Private", inline: true },
                        { name: '👥 Active Players', value: data.playing.toLocaleString(), inline: true },
                        { name: '👍 Likes', value: votes.upVotes.toLocaleString(), inline: true },
                        { name: '👎 Dislikes', value: votes.downVotes.toLocaleString(), inline: true },
                        { name: '⭐ Favorites', value: favRes.data.count.toLocaleString(), inline: true },
                        { name: '📈 Total Visits', value: data.visits.toLocaleString(), inline: true },
                        { name: '📅 Created On', value: new Date(data.created).toLocaleDateString(), inline: true }
                    )
                    .setFooter({ text: "Updating live every 60 seconds" })
                    .setTimestamp();

                await interaction.editReply({ content: '', embeds: [liveEmbed] });
            } catch (err) {
                console.error(err);
                await interaction.editReply("❌ Error: Couldn't find that game. Make sure the ID is correct!");
            }
        };

        // Run the update immediately, then every 60 seconds
        updateFeed();
        setInterval(updateFeed, 60000); 
    }
});

client.login(process.env.DISCORD_TOKEN);
