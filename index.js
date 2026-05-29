const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');

// --- 1. WEB SERVER FOR RENDER/UPTIMEROBOT ---
http.createServer((req, res) => {
    res.write("Bot is running!");
    res.end();
}).listen(process.env.PORT || 3000);

// --- 2. DISCORD BOT SETUP ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// Define the slash command
const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Starts the live data tracking feed')
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    // Automatically register the slash command globally
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});

// --- 3. HANDLE THE SLASH COMMAND ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'start') {
        // Create initial live embed
        const liveEmbed = new EmbedBuilder()
            .setTitle("Live Data Feed")
            .setDescription("Fetching initial data...")
            .setColor("#00FF00");

        // Reply to the slash command with the embed
        const msg = await interaction.reply({ embeds: [liveEmbed], fetchReply: true });

        // Update loop: Runs every 30 seconds
        setInterval(async () => {
            try {
                // Placeholder data for now
                const mockData = `Current Value: ${Math.floor(Math.random() * 1000)}`;

                const updatedEmbed = EmbedBuilder.from(liveEmbed)
                    .setDescription(`**Status:** ${mockData}`)
                    .setTimestamp();

                // Edit the original interaction response
                await interaction.editReply({ embeds: [updatedEmbed] });
            } catch (err) {
                console.error("Edit failed:", err);
            }
        }, 30000);
    }
});

client.login(process.env.DISCORD_TOKEN);
