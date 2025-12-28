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

        if (!sourceGuild) throw new Error('Source server not found');
        if (!targetGuild) throw new Error('Target server not found');

        this.sendProgress(`Cloning from: ${sourceGuild.name} -> ${targetGuild.name}`, progressChannel);

        await this.deleteExistingContent(targetGuild, progressChannel, cloneRoles);

        if (cloneRoles) {
            await this.cloneRoles(sourceGuild, targetGuild, progressChannel);
        } else {
            this.sendProgress('⏭️ Skipped role cloning.', progressChannel);
        }

        await this.cloneCategories(sourceGuild, targetGuild, progressChannel);
        await this.cloneChannels(sourceGuild, targetGuild, progressChannel);

        if (cloneEmojis) {
            await this.cloneEmojis(sourceGuild, targetGuild, progressChannel);
        }

        await this.cloneServerInfo(sourceGuild, targetGuild, progressChannel);

        this.showStats(progressChannel);
        this.sendProgress('🎉 Server cloning completed successfully!', progressChannel);
    }

    async deleteExistingContent(guild, progressChannel, cloneRoles) {
        this.sendProgress('🗑️ Deleting existing channels...', progressChannel);

        for (const [, channel] of guild.channels.cache.filter(ch => ch.deletable)) {
            try {
                await channel.delete();
                await delay(100);
            } catch {
                this.stats.failed++;
            }
        }

        if (!cloneRoles) {
            this.sendProgress('⏭️ Skipped deleting existing roles.', progressChannel);
            return;
        }

        this.sendProgress('🗑️ Deleting existing roles...', progressChannel);

        for (const [, role] of guild.roles.cache.filter(r =>
            r.name !== '@everyone' && !r.managed && r.editable
        )) {
            try {
                await role.delete();
                await delay(100);
            } catch {
                this.stats.failed++;
            }
        }
    }

    async cloneRoles(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('👑 Cloning roles...', progressChannel);

        const roles = sourceGuild.roles.cache
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => a.position - b.position);

        for (const [, role] of roles) {
            try {
                const newRole = await targetGuild.roles.create({
                    name: role.name,
                    color: role.hexColor,
                    permissions: role.permissions,
                    hoist: role.hoist,
                    mentionable: role.mentionable,
                    reason: 'Server cloning'
                });

                this.roleMapping.set(role.id, newRole.id);
                this.stats.rolesCreated++;
                await delay(200);
            } catch {
                this.stats.failed++;
            }
        }

        await this.fixRolePositions(sourceGuild, targetGuild);
    }

    async fixRolePositions(sourceGuild, targetGuild) {
        const sourceRoles = sourceGuild.roles.cache
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => b.position - a.position);

        for (const [, role] of sourceRoles) {
            const targetRole = targetGuild.roles.cache.find(r => r.name === role.name);
            if (targetRole?.editable) {
                try {
                    await targetRole.setPosition(role.position);
                    await delay(100);
                } catch {}
            }
        }
    }

    async cloneCategories(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('📁 Cloning categories...', progressChannel);

        const categories = sourceGuild.channels.cache
            .filter(c => c.type === 'GUILD_CATEGORY')
            .sort((a, b) => a.position - b.position);

        for (const [, category] of categories) {
            try {
                const overwrites = this.mapPermissionOverwrites(category.permissionOverwrites, targetGuild);
                await targetGuild.channels.create(category.name, {
                    type: 'GUILD_CATEGORY',
                    permissionOverwrites: overwrites,
                    position: category.position
                });
                this.stats.categoriesCreated++;
                await delay(200);
            } catch {
                this.stats.failed++;
            }
        }
    }

    async cloneChannels(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('💬 Cloning channels...', progressChannel);

        const channels = sourceGuild.channels.cache
            .filter(c => c.type === 'GUILD_TEXT' || c.type === 'GUILD_VOICE')
            .sort((a, b) => a.position - b.position);

        for (const [, channel] of channels) {
            try {
                const overwrites = this.mapPermissionOverwrites(channel.permissionOverwrites, targetGuild);
                const parent = channel.parent
                    ? targetGuild.channels.cache.find(c => c.name === channel.parent.name && c.type === 'GUILD_CATEGORY')
                    : null;

                const options = {
                    type: channel.type,
                    parent: parent?.id,
                    permissionOverwrites: overwrites,
                    position: channel.position
                };

                if (channel.type === 'GUILD_TEXT') {
                    options.topic = channel.topic;
                    options.nsfw = channel.nsfw;
                    options.rateLimitPerUser = channel.rateLimitPerUser;
                } else {
                    options.bitrate = channel.bitrate;
                    options.userLimit = channel.userLimit;
                }

                await targetGuild.channels.create(channel.name, options);
                this.stats.channelsCreated++;
                await delay(200);
            } catch {
                this.stats.failed++;
            }
        }
    }

    async cloneEmojis(sourceGuild, targetGuild, progressChannel) {
        this.sendProgress('😀 Cloning emojis...', progressChannel);

        for (const [, emoji] of sourceGuild.emojis.cache) {
            try {
                const img = await downloadImage(emoji.url);
                await targetGuild.emojis.create(img, emoji.name);
                this.stats.emojisCreated++;
                await delay(2000);
            } catch {
                this.stats.failed++;
            }
        }
    }

    async cloneServerInfo(sourceGuild, targetGuild) {
        await targetGuild.setName(sourceGuild.name);
        if (sourceGuild.iconURL()) {
            const icon = await downloadImage(sourceGuild.iconURL({ format: 'png', size: 1024 }));
            await targetGuild.setIcon(icon);
        }
    }

    mapPermissionOverwrites(overwrites, targetGuild) {
        const mapped = [];
        if (!overwrites?.cache) return mapped;

        overwrites.cache.forEach(o => {
            const id = this.roleMapping.get(o.id) || o.id;
            mapped.push({ id, type: o.type, allow: o.allow, deny: o.deny });
        });

        return mapped;
    }

    showStats(ch) {
        if (!ch) return;
        ch.send(
`📊 Cloning Statistics
Roles: ${this.stats.rolesCreated}
Categories: ${this.stats.categoriesCreated}
Channels: ${this.stats.channelsCreated}
Emojis: ${this.stats.emojisCreated}
Failed: ${this.stats.failed}`
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
