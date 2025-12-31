require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const https = require('https');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function retryOnRateLimit(fn, description, progressChannel) {
    while (true) {
        try {
            return await fn();
        } catch (error) {
            const isRateLimit =
                error?.code === 429 ||
                error?.status === 429 ||
                (typeof error.message === 'string' &&
                 error.message.toLowerCase().includes('rate limit'));

            if (!isRateLimit) throw error;

            const msg = `⏳ Rate limited while ${description}. Waiting 10 seconds...`;
            console.log(msg);
            if (progressChannel) progressChannel.send(msg).catch(() => {});
            await delay(10000);
        }
    }
}

async function downloadImage(url) {
    return retryOnRateLimit(() => new Promise((resolve, reject) => {
        https.get(url, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve(`data:${res.headers['content-type']};base64,${buffer.toString('base64')}`);
            });
        }).on('error', reject);
    }), 'downloading image');
}

class ServerCloner {
    constructor(client) {
        this.client = client;
        this.roleMapping = new Map();
        this.categoryMapping = new Map();
        this.stats = {
            rolesCreated: 0,
            categoriesCreated: 0,
            channelsCreated: 0,
            emojisCreated: 0,
            failed: 0
        };
    }

    async cloneServer(sourceId, targetId, cloneEmojis, progressChannel, cloneRoles) {
        const source = this.client.guilds.cache.get(sourceId);
        const target = this.client.guilds.cache.get(targetId);

        this.send(`🚀 Starting server cloning: ${source.name} → ${target.name}`, progressChannel);

        await this.deleteExistingChannels(target, progressChannel);

        if (cloneRoles) {
            await this.cloneRoles(source, target, progressChannel);
        } else {
            this.send('⏭️ Skipped role cloning.', progressChannel);
        }

        await this.cloneCategories(source, target, progressChannel);
        await this.cloneChannels(source, target, progressChannel);

        if (cloneEmojis) {
            await this.cloneEmojis(source, target, progressChannel);
        }

        await this.cloneServerInfo(source, target, progressChannel);

        this.send(
`🎉 SERVER CLONING COMPLETED
Roles Created: ${this.stats.rolesCreated}
Categories Created: ${this.stats.categoriesCreated}
Channels Created: ${this.stats.channelsCreated}
Emojis Created: ${this.stats.emojisCreated}
Failed Operations: ${this.stats.failed}`, progressChannel);
    }

    async deleteExistingChannels(guild, ch) {
        this.send('🗑️ Deleting existing channels...', ch);

        for (const [, channel] of guild.channels.cache.filter(c => c.deletable)) {
            await retryOnRateLimit(
                () => channel.delete(),
                `deleting channel ${channel.name}`,
                ch
            ).then(() => {
                this.send(`Deleted channel: ${channel.name}`, ch);
            }).catch(() => {
                this.stats.failed++;
            });
            await delay(100);
        }

        this.send('⏭️ Existing roles preserved.', ch);
    }

    async cloneRoles(source, target, ch) {
        this.send('👑 Cloning roles...', ch);

        const roles = source.roles.cache
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => a.position - b.position);

        for (const [, role] of roles) {
            try {
                const newRole = await retryOnRateLimit(
                    () => target.roles.create({
                        name: role.name,
                        color: role.hexColor,
                        permissions: role.permissions,
                        hoist: role.hoist,
                        mentionable: role.mentionable,
                        reason: 'Server cloning'
                    }),
                    `creating role ${role.name}`,
                    ch
                );

                this.roleMapping.set(role.id, newRole.id);
                this.stats.rolesCreated++;
                this.send(`Created role: ${role.name}`, ch);
                await delay(200);
            } catch {
                this.stats.failed++;
            }
        }
    }

    async cloneCategories(source, target, ch) {
        this.send('📁 Cloning categories...', ch);

        const categories = source.channels.cache
            .filter(c => c.type === 'GUILD_CATEGORY')
            .sort((a, b) => a.position - b.position);

        for (const [, category] of categories) {
            try {
                const newCat = await retryOnRateLimit(
                    () => target.channels.create(category.name, {
                        type: 'GUILD_CATEGORY',
                        position: category.position,
                        permissionOverwrites: this.mapPermissionOverwrites(category.permissionOverwrites)
                    }),
                    `creating category ${category.name}`,
                    ch
                );

                this.categoryMapping.set(category.id, newCat.id);
                this.stats.categoriesCreated++;
                this.send(`Created category: ${category.name}`, ch);
                await delay(200);
            } catch {
                this.stats.failed++;
            }
        }
    }

    async cloneChannels(source, target, ch) {
        this.send('💬 Cloning channels...', ch);

        const channels = source.channels.cache
            .filter(c => c.type !== 'GUILD_CATEGORY')
            .sort((a, b) => a.position - b.position);

        for (const [, channel] of channels) {
            try {
                const parentId = channel.parent
                    ? this.categoryMapping.get(channel.parent.id)
                    : null;

                await retryOnRateLimit(
                    () => target.channels.create(channel.name, {
                        type: channel.type,
                        parent: parentId,
                        position: channel.position,
                        permissionOverwrites: this.mapPermissionOverwrites(channel.permissionOverwrites),
                        topic: channel.topic,
                        nsfw: channel.nsfw,
                        bitrate: channel.bitrate,
                        userLimit: channel.userLimit,
                        rateLimitPerUser: channel.rateLimitPerUser
                    }),
                    `creating channel ${channel.name}`,
                    ch
                );

                this.stats.channelsCreated++;
                this.send(`Created channel: ${channel.name}`, ch);
                await delay(200);
            } catch {
                this.stats.failed++;
            }
        }
    }

    async cloneEmojis(source, target, ch) {
        this.send('😀 Cloning emojis...', ch);

        for (const [, emoji] of source.emojis.cache) {
            try {
                const img = await downloadImage(emoji.url);
                await retryOnRateLimit(
                    () => target.emojis.create(img, emoji.name),
                    `creating emoji ${emoji.name}`,
                    ch
                );

                this.stats.emojisCreated++;
                this.send(`Created emoji: ${emoji.name}`, ch);
                await delay(2000);
            } catch {
                this.stats.failed++;
            }
        }
    }

    async cloneServerInfo(source, target, ch) {
        await retryOnRateLimit(
            () => target.setName(source.name),
            'updating server name',
            ch
        );

        if (source.iconURL()) {
            const icon = await downloadImage(source.iconURL({ format: 'png', size: 1024 }));
            await retryOnRateLimit(
                () => target.setIcon(icon),
                'updating server icon',
                ch
            );
        }

        this.send('🏠 Server info cloned.', ch);
    }

    mapPermissionOverwrites(overwrites) {
        if (!overwrites?.cache) return [];
        return overwrites.cache.map(o => ({
            id: this.roleMapping.get(o.id) || o.id,
            type: o.type,
            allow: o.allow,
            deny: o.deny
        }));
    }

    send(msg, ch) {
        console.log(msg);
        if (ch) ch.send(msg).catch(() => {});
    }
}

const client = new Client();
const pending = new Map();

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (pending.has(message.author.id)) {
        const op = pending.get(message.author.id);
        const res = message.content.toLowerCase();

        if (!['y','n','yes','no'].includes(res)) return;

        if (op.step === 'proceed') {
            op.step = 'emojis';
            return message.channel.send('❓ Do you want to clone emojis too? (y/n)');
        }

        if (op.step === 'emojis') {
            op.cloneEmojis = res.startsWith('y');
            op.step = 'roles';
            return message.channel.send('❓ Do you want to clone roles too? (y/n)');
        }

        if (op.step === 'roles') {
            op.cloneRoles = res.startsWith('y');
            pending.delete(message.author.id);

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
        pending.set(message.author.id, {
            step: 'proceed',
            sourceGuildId: src,
            targetGuildId: tgt,
            cloneEmojis: true,
            cloneRoles: true
        });
        message.channel.send('❓ Do you want to proceed? (y/n)');
    }
});

client.login(process.env.TOKEN);
