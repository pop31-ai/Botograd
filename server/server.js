/**
 * @fileoverview Сервер Ботоград — интенсивный тайминг-экшен
 * @description
 * Управляет миром: волны бонусов, боссы, эвенты, накопления.
 * Всё предсказуемо по ID игрока и времени.
 * @see CONCEPT.md
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** Конфигурация таймингов (мс) */
const TIMERS = {
    BONUS_WAVE:   10000,   // 10 сек — волна бонусов
    EVENT:        30000,   // 30 сек — случайный эвент
    BOSS:         60000,   // 60 сек — босс
    SUPER_BONUS:  120000,  // 120 сек — супер-бонус
    SYNC:         30000    // 30 сек — синхронизация
};

/** Типы бонусов */
const BONUS_TYPES = [
    { id: 'hp',       icon: '❤️',  name: 'Лечение',     effect: { hp: 25 } },
    { id: 'shield',   icon: '🛡️',  name: 'Щит',        effect: { shield: 10 } },
    { id: 'speed',    icon: '⚡',  name: 'Ускорение',   effect: { speed: 2, duration: 10000 } },
    { id: 'magnet',   icon: '🧲',  name: 'Магнит',      effect: { magnetRadius: 3, duration: 5000 } },
    { id: 'crit',     icon: '💥',  name: 'Крит',        effect: { critMulti: 3, duration: 5000 } },
    { id: 'combo',    icon: '🔥',  name: 'Комбо',       effect: { combo: 1 } },
    { id: 'resource', icon: '💎',  name: 'Ресурс',      effect: { resources: 10 } },
    { id: 'xp',       icon: '⭐',  name: 'Опыт',        effect: { xp: 50 } },
    { id: 'map',      icon: '🗺️',  name: 'Карта',       effect: { mapReveal: true } },
    { id: 'key',      icon: '🗝️',  name: 'Ключ',        effect: { keys: 1 } },
    { id: 'chest',    icon: '🎁',  name: 'Сундук',      effect: { random: true } },
    { id: 'super',    icon: '🌟',  name: 'Супер',       effect: { allX2: true, duration: 15000 } }
];

/** Типы сообщений (20+) */
const MSG_TYPES = [
    'STATUS', 'SPAWN', 'PICKUP', 'DAMAGE', 'HEAL',
    'BUFF', 'DEBUFF', 'COMBO', 'CRIT', 'WAVE',
    'BOSS', 'KILL', 'LEVELUP', 'QUEST', 'TRADE',
    'LOOT', 'EVENT', 'SYNC', 'ERROR', 'SYSTEM'
];

/** Классы роботов */
const ROBOT_CLASSES = [
    { id: 0, name: 'Огнемёт',   color: '#ff4444', ability: 'burn',    passive: '+2 урон/сек' },
    { id: 1, name: 'Щитовик',   color: '#44ff44', ability: 'shield',  passive: '+50% HP' },
    { id: 2, name: 'Скоростной', color: '#ffff44', ability: 'double',  passive: 'x2 бонусы' },
    { id: 3, name: 'Магнит',    color: '#44ffff', ability: 'attract', passive: '+3 радиус' },
    { id: 4, name: 'Телепорт',  color: '#4444ff', ability: 'blink',   passive: '+1 телепорт/мин' },
    { id: 5, name: 'Берсерк',   color: '#ff44ff', ability: 'rage',    passive: '+3% урон/1% HP' }
];

/** Сид из ID */
function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

/** Детерминированный рандом */
function seededRandom(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
}

/** Генерация мира по ID */
function generateWorld(playerId) {
    const seed = hashCode(playerId);
    return {
        class: seed % 6,
        bossPattern: seed % 4,
        eventChance: (seed % 30) + 20,
        bonusMultiplier: 1 + (seed % 3) * 0.5
    };
}

/**
 * Класс GameState — управление состоянием всех игроков
 */
class GameState {
    constructor() {
        this.players = new Map();
        this.bonuses = new Map(); // бонусы на карте
        this.boss = null;
        this.waveNumber = 0;
        this.bossNumber = 0;
        this.gameTime = 0;
        this.lastBonusWave = Date.now();
        this.lastEvent = Date.now();
        this.lastBoss = Date.now();
        this.lastSuperBonus = Date.now();
        this.bonusIdCounter = 0;

        this.startTimers();
        this.log('SYSTEM', 'Ботоград сервер запущен');
    }

    /**
     * Запуск всех таймеров
     * @description Каждый таймер генерирует ивенты и рассылает уведомления
     */
    startTimers() {
        // Волна бонусов каждые 10 сек
        setInterval(() => this.spawnBonusWave(), TIMERS.BONUS_WAVE);
        // Случайный эвент каждые 30 сек
        setInterval(() => this.triggerEvent(), TIMERS.EVENT);
        // Босс каждые 60 сек
        setInterval(() => this.spawnBoss(), TIMERS.BOSS);
        // Супер-бонус каждые 120 сек
        setInterval(() => this.spawnSuperBonus(), TIMERS.SUPER_BONUS);
    }

    /** Логирование с типом сообщения */
    log(type, message, data = {}) {
        const entry = { type, message, data, time: Date.now() };
        console.log(`[${type}] ${message}`);
        this.broadcast({ type: 'log', data: entry });
    }

    /**
     * Спавн волны бонусов
     * @description Генерирует 3-5 бонусов в случайных позициях
     */
    spawnBonusWave() {
        this.waveNumber++;
        const count = 3 + Math.floor(Math.random() * 3);
        const wave = [];

        for (let i = 0; i < count; i++) {
            const bonusType = BONUS_TYPES[Math.floor(Math.random() * 12)];
            const bonus = {
                id: this.bonusIdCounter++,
                type: bonusType,
                x: Math.random() * 100,
                y: Math.random() * 100,
                spawned: Date.now(),
                ttl: 15000
            };
            this.bonuses.set(bonus.id, bonus);
            wave.push(bonus);
        }

        this.log('WAVE', `Волна #${this.waveNumber}: ${count} бонусов`, { wave });
        this.broadcast({ type: 'wave', data: { waveNumber: this.waveNumber, bonuses: wave } });
    }

    /**
     * Случайный эвент
     * @description 20-50% шанс на полезный/вредный эвент
     */
    triggerEvent() {
        const events = [
            { id: 'storm',    name: '⚡ Шторм',       effect: 'damage_all',   value: 10, negative: true },
            { id: 'luck',     name: '🍀 Удача',       effect: 'bonus_x2',     value: 2,  negative: false },
            { id: 'magnet',   name: '🧲 Магнит-волна', effect: 'attract_all',  value: 0,  negative: false },
            { id: 'poison',   name: '☠️ Ядовитый туман', effect: 'dot',        value: 5,  negative: true },
            { id: 'heal',     name: '💚 Лечебный дождь', effect: 'heal_all',   value: 20, negative: false },
            { id: 'slow',     name: '🐌 Замедление',   effect: 'slow_all',     value: 0.5, negative: true },
            { id: 'gold',     name: '💰 Золотой дождь', effect: 'resources',   value: 25, negative: false },
            { id: 'berserk',  name: ' fury',            effect: 'damage_x2',   value: 2,  negative: false }
        ];

        const event = events[Math.floor(Math.random() * events.length)];
        this.log('EVENT', event.name, { event });

        // Применяем к игрокам
        this.players.forEach((player) => {
            if (event.negative) {
                this.applyDamage(player, event.value);
            } else {
                this.applyEvent(player, event);
            }
        });

        this.broadcast({ type: 'event', data: event });
    }

    /** Спавн босса */
    spawnBoss() {
        this.bossNumber++;
        const hp = 100 + this.bossNumber * 50;
        this.boss = {
            id: this.bossNumber,
            hp,
            maxHp: hp,
            x: 50,
            y: 0,
            pattern: this.bossNumber % 4,
            spawned: Date.now()
        };
        this.log('BOSS', `Босс #${this.bossNumber} (HP: ${hp})`, { boss: this.boss });
        this.broadcast({ type: 'boss', data: this.boss });
    }

    /** Спавн супер- бонуса */
    spawnSuperBonus() {
        const bonus = {
            id: this.bonusIdCounter++,
            type: BONUS_TYPES[11], // super
            x: 50,
            y: 50,
            spawned: Date.now(),
            ttl: 20000,
            isSuper: true
        };
        this.bonuses.set(bonus.id, bonus);
        this.log('SPAWN', '🌟 Супер-бонус на карте!', { bonus });
        this.broadcast({ type: 'superBonus', data: bonus });
    }

    /** Применение урона */
    applyDamage(player, amount) {
        if (player.shield > 0) {
            const blocked = Math.min(player.shield, amount);
            player.shield -= blocked;
            amount -= blocked;
            this.log('BLOCK', `Щит заблокировал ${blocked}`, { playerId: player.id });
        }
        player.hp = Math.max(0, player.hp - amount);
        this.log('DAMAGE', `${player.name} получил ${amount} урона (HP: ${player.hp})`, { playerId: player.id, damage: amount });
        if (player.hp <= 0) {
            this.onPlayerDeath(player);
        }
    }

    /** Применение эвента */
    applyEvent(player, event) {
        switch (event.effect) {
            case 'heal_all':
                player.hp = Math.min(player.maxHp, player.hp + event.value);
                this.log('HEAL', `${player.name} +${event.value} HP`, { playerId: player.id });
                break;
            case 'resources':
                player.resources += event.value;
                this.log('LOOT', `${player.name} +${event.value} ресурсов`, { playerId: player.id });
                break;
            case 'bonus_x2':
            case 'damage_x2':
                player.buffs[event.id] = { value: event.value, until: Date.now() + 10000 };
                this.log('BUFF', `${player.name}: ${event.name}`, { playerId: player.id, buff: event.id });
                break;
        }
    }

    /** Смерть игрока */
    onPlayerDeath(player) {
        player.hp = player.maxHp;
        player.combo = 0;
        player.resources = Math.floor(player.resources * 0.8);
        this.log('SYSTEM', `${player.name} умер! Потеряно 20% ресурсов`, { playerId: player.id });
    }

    /** Подбор бонуса */
    pickupBonus(playerId, bonusId) {
        const player = this.players.get(playerId);
        const bonus = this.bonuses.get(bonusId);
        if (!player || !bonus) return null;

        this.bonuses.delete(bonusId);

        // Применяем эффект
        const eff = bonus.type.effect;
        if (eff.hp) {
            player.hp = Math.min(player.maxHp, player.hp + eff.hp);
            this.log('HEAL', `${player.name} +${eff.hp} HP`, { playerId });
        }
        if (eff.shield) {
            player.shield += eff.shield;
            this.log('BUFF', `${player.name} +${eff.shield} ЩИТ`, { playerId });
        }
        if (eff.speed) {
            player.buffs.speed = { value: eff.speed, until: Date.now() + eff.duration };
            this.log('BUFF', `${player.name}: УСКОРЕНИЕ x${eff.speed}`, { playerId });
        }
        if (eff.critMulti) {
            player.buffs.crit = { value: eff.critMulti, until: Date.now() + eff.duration };
            this.log('BUFF', `${player.name}: КРИТ x${eff.critMulti}`, { playerId });
        }
        if (eff.combo) {
            player.combo += eff.combo;
            if (player.combo > player.maxCombo) player.maxCombo = player.combo;
            this.log('COMBO', `${player.name}: КОМБО ${player.combo}x`, { playerId, combo: player.combo });
        }
        if (eff.resources) {
            player.resources += eff.resources;
            this.log('LOOT', `${player.name} +${eff.resources}💎`, { playerId });
        }
        if (eff.xp) {
            this.addXP(player, eff.xp);
        }
        if (eff.random) {
            const randomBonus = BONUS_TYPES[Math.floor(Math.random() * 11)];
            this.log('LOOT', `${player.name} открыл сундук: ${randomBonus.icon} ${randomBonus.name}`, { playerId, loot: randomBonus });
        }
        if (eff.allX2) {
            player.buffs.super = { value: 2, until: Date.now() + eff.duration };
            this.log('BUFF', `${player.name}: ВСЁ x2 на 15 сек!`, { playerId });
        }

        this.log('PICKUP', `${player.name} подобрал ${bonus.type.icon} ${bonus.type.name}`, { playerId, bonus });

        return { bonus, player };
    }

    /** Начисление опыта */
    addXP(player, amount) {
        const superBuff = player.buffs.super;
        const multiplier = superBuff && superBuff.until > Date.now() ? 2 : 1;
        player.xp += amount * multiplier;

        const needed = player.level * 100;
        if (player.xp >= needed) {
            player.xp -= needed;
            player.level++;
            player.maxHp += 10;
            player.hp = player.maxHp;
            player.damage += 2;
            this.log('LEVELUP', `🎉 ${player.name} УРОВЕНЬ ${player.level}!`, { playerId: player.id, level: player.level });

            // Проверка престижа
            if (player.level % 10 === 0) {
                player.prestige++;
                this.log('SYSTEM', `⭐ ${player.name} ПРЕСТИЖ ${player.prestige}!`, { playerId: player.id });
            }
        }
    }

    /** Убийство босса */
    killBoss(playerId) {
        if (!this.boss) return;
        const player = this.players.get(playerId);
        if (!player) return;

        this.log('KILL', `${player.name} убил босса #${this.boss.id}!`, { playerId, bossId: this.boss.id });

        // Награда
        const reward = 50 + this.bossNumber * 25;
        player.resources += reward;
        player.bossKills++;
        this.addXP(player, 100);

        this.log('LOOT', `${player.name} +${reward}💎 за босса`, { playerId });

        this.boss = null;
        this.broadcast({ type: 'bossKill', data: { killer: playerId, reward } });
    }

    /** Присоединение к игре */
    joinGame(playerId, name) {
        let player = this.loadPlayer(playerId);

        if (!player) {
            const world = generateWorld(playerId);
            const robotClass = ROBOT_CLASSES[world.class];
            player = {
                id: playerId,
                name: name || `Меха-${playerId.slice(-4)}`,
                class: world.class,
                className: robotClass.name,
                classColor: robotClass.color,
                level: 1,
                xp: 0,
                hp: 100,
                maxHp: 100,
                shield: 0,
                damage: 10,
                speed: 1.0,
                resources: 0,
                prestige: 0,
                combo: 0,
                maxCombo: 0,
                bossKills: 0,
                wavesCleared: 0,
                buffs: {},
                inventory: [],
                unlockedSkins: [0],
                activeSkin: 0,
                position: { x: 50, y: 50 },
                keys: 0,
                lastSync: Date.now(),
                world
            };
        }

        this.players.set(playerId, player);
        this.savePlayer(playerId, player);
        this.log('SYSTEM', `${player.name} (${ROBOT_CLASSES[player.class].name}) присоединился`, { playerId });

        return player;
    }

    /** Обработка действия */
    performAction(playerId, action) {
        const player = this.players.get(playerId);
        if (!player) return { error: 'Игрок не найден' };

        let result = { success: false };

        switch (action.type) {
            case 'move':
                player.position = action.target;
                result = { success: true, position: player.position };
                break;

            case 'attack':
                if (this.boss) {
                    const critBuff = player.buffs.crit;
                    const critMult = critBuff && critBuff.until > Date.now() ? critBuff.value : 1;
                    const dmg = Math.floor(player.damage * critMult);
                    this.boss.hp -= dmg;
                    if (critMult > 1) this.log('CRIT', `${player.name} КРИТ! ${dmg} урона`, { playerId, damage: dmg });
                    else this.log('DAMAGE', `${player.name} нанёс ${dmg} урона`, { playerId, damage: dmg });

                    if (this.boss.hp <= 0) {
                        this.killBoss(playerId);
                    }
                    result = { success: true, bossHp: this.boss?.hp || 0, damage: dmg };
                } else {
                    result = { error: 'Нет босса' };
                }
                break;

            case 'pickup':
                const pickup = this.pickupBonus(playerId, action.bonusId);
                if (pickup) result = { success: true, bonus: pickup.bonus };
                else result = { error: 'Бонус не найден' };
                break;

            case 'chest':
                if (player.keys > 0) {
                    player.keys--;
                    const loot = BONUS_TYPES[Math.floor(Math.random() * 11)];
                    this.log('LOOT', `${player.name} открыл сундук: ${loot.icon}`, { playerId });
                    this.pickupBonus(playerId, this.spawnSpecificBonus(loot, player.position));
                    result = { success: true, loot };
                } else {
                    result = { error: 'Нет ключей' };
                }
                break;
        }

        this.savePlayer(playerId, player);
        return result;
    }

    /** Спавн конкретного бонуса */
    spawnSpecificBonus(type, pos) {
        const id = this.bonusIdCounter++;
        this.bonuses.set(id, { id, type, x: pos.x, y: pos.y, spawned: Date.now(), ttl: 15000 });
        return id;
    }

    /** Синхронизация */
    getTimeSync() {
        return {
            timestamp: Date.now(),
            waveNumber: this.waveNumber,
            bossNumber: this.bossNumber,
            boss: this.boss,
            bonusCount: this.bonuses.size,
            nextWave: TIMERS.BONUS_WAVE - (Date.now() - this.lastBonusWave),
            nextEvent: TIMERS.EVENT - (Date.now() - this.lastEvent),
            nextBoss: TIMERS.BOSS - (Date.now() - this.lastBoss)
        };
    }

    /** Рассылка всем клиентам */
    broadcast(msg) {
        const data = JSON.stringify(msg);
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
    }

    /** Таблица лидеров */
    getLeaderboard() {
        return Array.from(this.players.values())
            .sort((a, b) => b.resources - a.resources)
            .slice(0, 10)
            .map(p => ({ name: p.name, level: p.level, resources: p.resources, prestige: p.prestige }));
    }

    /** Загрузка игрока */
    loadPlayer(id) {
        const fp = path.join(__dirname, '../players', `${id}.json`);
        try {
            if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
        } catch (e) { console.error(`Load error ${id}:`, e); }
        return null;
    }

    /** Сохранение игрока */
    savePlayer(id, player) {
        const dir = path.join(__dirname, '../players');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const fp = path.join(dir, `${id}.json`);
        try { fs.writeFileSync(fp, JSON.stringify(player, null, 2)); }
        catch (e) { console.error(`Save error ${id}:`, e); }
    }
}

const gameState = new GameState();

// HTTP
app.use(express.static(path.join(__dirname, '../client')));
app.get('/api/time', (req, res) => res.json(gameState.getTimeSync()));
app.get('/api/leaderboard', (req, res) => res.json(gameState.getLeaderboard()));
app.get('/api/state/:id', (req, res) => {
    const p = gameState.players.get(req.params.id);
    p ? res.json(p) : res.status(404).json({ error: 'Не найден' });
});

// WebSocket
wss.on('connection', (ws) => {
    let pid = null;
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            switch (msg.type) {
                case 'join':
                    pid = msg.id;
                    const player = gameState.joinGame(msg.id, msg.name);
                    ws.send(JSON.stringify({ type: 'joined', data: player }));
                    ws.send(JSON.stringify({ type: 'bonuses', data: Array.from(gameState.bonuses.values()) }));
                    break;
                case 'action':
                    if (pid) {
                        const r = gameState.performAction(pid, msg.action);
                        ws.send(JSON.stringify({ type: 'actionResult', data: r }));
                        const updated = gameState.players.get(pid);
                        ws.send(JSON.stringify({ type: 'playerUpdate', data: updated }));
                    }
                    break;
                case 'sync':
                    ws.send(JSON.stringify({ type: 'timeSync', data: gameState.getTimeSync() }));
                    break;
                case 'leaderboard':
                    ws.send(JSON.stringify({ type: 'leaderboard', data: gameState.getLeaderboard() }));
                    break;
            }
        } catch (e) { console.error('WS error:', e); }
    });
    ws.on('close', () => { if (pid) gameState.log('SYSTEM', `${pid} отключился`); });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`\n🤖 БОТОГРАД запущен на порту ${PORT}`);
    console.log(`   Волна бонусов: ${TIMERS.BONUS_WAVE/1000}с`);
    console.log(`   Эвенты: ${TIMERS.EVENT/1000}с`);
    console.log(`   Боссы: ${TIMERS.BOSS/1000}с`);
    console.log(`   Супер: ${TIMERS.SUPER_BONUS/1000}с\n`);
});
