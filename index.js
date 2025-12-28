require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const https = require('https');

const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    reset: '\x1b[0m'
};

const log = {
    success: (msg) => console.log(`${colors.green}[+] ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}[-] ${msg}${colors.reset}`),
    warning: (msg) => console.log(`${colors.yellow}[!] ${msg}${colors.reset}`),
    info: (msg) => console.log(`${colors.cyan}[i] ${msg}${colors.reset}`)
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function downloadImage(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const base64 = buffer.toString('base64');
                const mimeType = res.headers['content-type'] || 'image/png';
                resolve(`data:${mimeType};base64,${base64}`);
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

class ServerCloner {
    constructor(client) {
        this.client = client;
        this.roleMapping = new Map();
        this.stats = {
            rolesCreated: 0,
            categoriesCreated: 0,
            channelsCreated: 0,
            emojisCreated: 0,
            failed: 0
        };
    }

    async cloneServer(sourceGuildId, targetGuildId, cloneEmojis = true, progressChannel = null, cloneRoles = true) {
        const sourceGuild = this.client.guilds.cache.get(sourceGuildId);
        const targetGuild = this.client.guilds.cache.get(targetGuildId);

        this.sendProgress(`Cloning from: ${sourceGuild.name} → ${targetGuild.name}`, progressChannel);

        await this.deleteExistingContent(targetGuild, progressChannel, cloneRoles);

        if (cloneRoles) {
            await this.cloneRoles(sourceGuild, targetGuild, progressChannel);
        } else {
            this.sendProgress('⏭️ Skipped role cloning & deletion.', progressChannel);
        }

        await this.cloneCategories(sourceGuild, targetGuild, progressChannel);
        await this.cloneChannels(sourceGuild, targetGuild, progressChannel);

        if (cloneEmojis) {
            await this.cloneEmojis(sourceGuild, targetGuild, progressChannel);
        }

        await this.cloneServerInfo(sourceGuild, targetGuild, progressChannel);
        this.showStats(progressChannel);
    }

    async deleteExistingContent(guild, progressChannel, cloneRoles) {
        this.sendProgress('🗑️ Deleting existing channels...', progressChannel);

        for (const [, channel] of guild.channels.cache.filter(c => c.deletable)) {
            await channel.delete().catch(() => {});
            await delay(100);
        }

        if (!cloneRoles) {
            this.sendProgress('⏭️ Skipped deleting existing roles.', progressChannel);
            return;
        }

        this.sendProgress('🗑️ Deleting existing roles...', progressChannel);

        for (const [, role] of guild.roles.cache.filter(r =>
            r.name !== '@everyone' && !r.managed && r.editable
        )) {
            await role.delete().catch(() => {});
            await delay(100);
        }
    }

    async cloneRoles(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('👑 Cloning roles...', progressChannel);

        const roles = sourceGuild.roles.cache
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => a.position - b.position);

        for (const [, role] of roles) {
            const newRole = await targetGuild.roles.create({
                name: role.name,
                color: role.hexColor,
                permissions: role.permissions,
                hoist: role.hoist,
                mentionable: role.mentionable
            }).catch(() => null);

            if (newRole) {
                this.roleMapping.set(role.id, newRole.id);
                this.stats.rolesCreated++;
            }

            await delay(200);
        }
    }

    async cloneCategories(sourceGuild, targetGuild, progressChannel) {
        for (const [, cat] of sourceGuild.channels.cache.filter(c => c.type === 'GUILD_CATEGORY')) {
            await targetGuild.channels.create(cat.name, { type: 'GUILD_CATEGORY' }).catch(() => {});
            this.stats.categoriesCreated++;
            await delay(200);
        }
    }

    async cloneChannels(sourceGuild, targetGuild, progressChannel) {
        for (const [, ch] of sourceGuild.channels.cache.filter(c =>
            c.type === 'GUILD_TEXT' || c.type === 'GUILD_VOICE'
        )) {
            await targetGuild.channels.create(ch.name, { type: ch.type }).catch(() => {});
            this.stats.channelsCreated++;
            await delay(200);
        }
    }

    async cloneEmojis(sourceGuild, targetGuild, progressChannel) {
        for (const [, emoji] of sourceGuild.emojis.cache) {
            const img = await downloadImage(emoji.url).catch(() => null);
            if (img) {
                await targetGuild.emojis.create(img, emoji.name).catch(() => {});
                this.stats.emojisCreated++;
            }
            await delay(2000);
        }
    }

    async cloneServerInfo(sourceGuild, targetGuild) {
        await targetGuild.setName(sourceGuild.name).catch(() => {});
    }

    showStats(ch) {
        if (!ch) return;
        ch.send(
`📊 Stats
Roles: ${this.stats.rolesCreated}
Categories: ${this.stats.categoriesCreated}
Channels: ${this.stats.channelsCreated}
Emojis: ${this.stats.emojisCreated}`
        ).catch(() => {});
    }

    sendProgress(msg, ch) {
        if (ch) ch.send(msg).catch(() => {});
        console.log(msg);
    }
}

const pendingOperations = new Map();
const client = new Client();

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (pendingOperations.has(message.author.id)) {
        const op = pendingOperations.get(message.author.id);
        const res = message.content.toLowerCase();

        if (!['y','n','yes','no'].includes(res)) return;

        if (op.step === 'confirmProceed') {
            op.step = 'confirmEmojis';
            return message.channel.send('❓ Do you want to clone emojis too? (y/n)');
        }

        if (op.step === 'confirmEmojis') {
            op.cloneEmojis = res.startsWith('y');
            op.step = 'confirmRoles';
            return message.channel.send('❓ Do you want to clone roles too? (y/n)');
        }

        if (op.step === 'confirmRoles') {
            op.cloneRoles = res.startsWith('y');
            pendingOperations.delete(message.author.id);

            const cloner = new ServerCloner(client);
            await cloner.cloneServer(
                op.sourceGuildId,
                op.targetGuildId,
                op.cloneEmojis,
                message.channel,
                op.cloneRoles
            );
        }
        return;
    }

    if (message.content.startsWith('!clone')) {
        const [, src, tgt] = message.content.split(/\s+/);
        pendingOperations.set(message.author.id, {
            step: 'confirmProceed',
            sourceGuildId: src,
            targetGuildId: tgt,
            cloneEmojis: true,
            cloneRoles: true
        });
        message.channel.send('❓ Do you want to proceed? (y/n)');
    }
});

client.login(process.env.TOKEN);
