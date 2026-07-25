/**
 * Тестовый раннер Ботоград — JSON-сценарии через WebSocket
 * Usage: node runner.js [scenario-file.json]
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const SERVER = process.env.SERVER || 'ws://localhost:3001';
const TIMEOUT = 5000;

let ws;
const msgQueue = [];
const msgWaiters = [];

function connect() {
    return new Promise((resolve, reject) => {
        ws = new WebSocket(SERVER);
        ws.on('open', () => resolve());
        ws.on('error', e => reject(e));
        ws.on('message', raw => {
            const msg = JSON.parse(raw);
            deliver(msg);
        });
    });
}

function deliver(msg) {
    for (let i = 0; i < msgWaiters.length; i++) {
        if (msgWaiters[i].type === msg.type) {
            const w = msgWaiters.splice(i, 1)[0];
            w.resolve(msg);
            return;
        }
    }
    msgQueue.push(msg);
}

function waitMsg(expectedType, timeout) {
    return new Promise((resolve, reject) => {
        const idx = msgQueue.findIndex(m => m.type === expectedType);
        if (idx !== -1) {
            resolve(msgQueue.splice(idx, 1)[0]);
            return;
        }
        const entry = { type: expectedType, resolve, reject };
        const t = setTimeout(() => {
            const wi = msgWaiters.indexOf(entry);
            if (wi !== -1) msgWaiters.splice(wi, 1);
            reject(new Error(`Timeout waiting for ${expectedType}`));
        }, timeout || TIMEOUT);
        entry.timeout = t;
        msgWaiters.push(entry);
    });
}

function drainMsgs(type) {
    msgQueue.length = 0;
    msgWaiters.length = 0;
}

function send(obj) { ws.send(JSON.stringify(obj)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function logStep(result, step, ok, detail) {
    result.steps.push({ step, result: ok ? `PASS — ${detail}` : `FAIL — ${detail}` });
    console.log(`  ${ok ? '✓' : '✗'} ${step} → ${detail}`);
}

async function doAction(action) {
    send({ type: 'action', action });
    const ar = await waitMsg('actionResult');
    const pu = await waitMsg('playerUpdate');
    return { result: ar.data, player: pu.data };
}

async function runScenario(scenario) {
    const result = { name: scenario.name, steps: [], pass: true };
    console.log(`\n${'='.repeat(60)}`);
    console.log(`▶ ${scenario.name}`);
    console.log(`${'='.repeat(60)}`);

    msgQueue.length = 0;
    msgWaiters.length = 0;

    const pf = path.join(__dirname, '..', 'players', `${scenario.userId}.json`);
    try { if (fs.existsSync(pf)) fs.unlinkSync(pf); } catch(e) {}

    // Fresh connection per scenario
    if (ws) { try { ws.close(); } catch(e) {} }
    await connect();
    await sleep(100);

    send({ type: 'join', id: scenario.userId, name: scenario.callsign });
    const joined = await waitMsg('joined');
    // Server also sends 'bonuses' after join
    try { await waitMsg('bonuses', 2000); } catch(e) {}
    // Server may also broadcast 'log' on join - drain it
    await sleep(50);
    drainMsgs();

    let player = joined.data;
    console.log(`  ✓ join → ${player.name}, class=${player.className}, level=${player.level}`);

    for (const step of scenario.steps) {
        try {
            switch (step.action) {

                case 'doAction': {
                    const r = await doAction(step.actionType);
                    player = r.player;
                    // Drain any broadcast messages (log, wave, event, etc.)
                    await sleep(20);
                    drainMsgs();

                    const c = [];
                    if (step.expect) {
                        if (step.expect.success !== undefined) c.push(r.result.success === step.expect.success ? `success=${r.result.success}✓` : `✗ success=${r.result.success}`);
                        if (step.expect.error !== undefined) c.push((r.result.error || '').includes(step.expect.error) ? `error✓` : `✗ error=${r.result.error}`);
                        if (step.expect.resources !== undefined) c.push(player.resources === step.expect.resources ? `res=${player.resources}✓` : `✗ res=${player.resources}`);
                        if (step.expect.hp !== undefined) c.push(player.hp === step.expect.hp ? `hp=${player.hp}✓` : `✗ hp=${player.hp}`);
                        if (step.expect.maxHp !== undefined) c.push(player.maxHp === step.expect.maxHp ? `maxHp=${player.maxHp}✓` : `✗ maxHp=${player.maxHp}`);
                        if (step.expect.level !== undefined) c.push(player.level === step.expect.level ? `lvl=${player.level}✓` : `✗ lvl=${player.level}`);
                        if (step.expect.prestige !== undefined) c.push(player.prestige === step.expect.prestige ? `prestige=${player.prestige}✓` : `✗ prestige=${player.prestige}`);
                        if (step.expect.bossKills !== undefined) c.push(player.bossKills === step.expect.bossKills ? `bk=${player.bossKills}✓` : `✗ bk=${player.bossKills}`);
                        if (step.expect.position !== undefined) c.push(JSON.stringify(player.position) === JSON.stringify(step.expect.position) ? `pos✓` : `✗ pos=${JSON.stringify(player.position)}`);
                    }
                    const ok = c.every(s => s.includes('✓'));
                    if (!ok) result.pass = false;
                    logStep(result, `action:${step.actionType.type}`, ok, c.length ? c.join(', ') : `ok`);
                    break;
                }

                case 'checkPlayer': {
                    const c = [];
                    if (step.expect) {
                        for (const [k, v] of Object.entries(step.expect)) {
                            if (typeof v === 'object' && v !== null) {
                                c.push(JSON.stringify(player[k]) === JSON.stringify(v) ? `${k}✓` : `✗ ${k}=${JSON.stringify(player[k])}`);
                            } else {
                                c.push(player[k] === v ? `${k}=${player[k]}✓` : `✗ ${k}=${player[k]} need=${v}`);
                            }
                        }
                    }
                    const ok = c.every(s => s.includes('✓'));
                    if (!ok) result.pass = false;
                    logStep(result, 'checkPlayer', ok, c.join(', '));
                    break;
                }

                case 'leaderboard': {
                    send({ type: 'leaderboard' });
                    const lb = await waitMsg('leaderboard');
                    const c = [];
                    if (step.expect) {
                        if (step.expect.minEntries !== undefined) c.push(lb.data.length >= step.expect.minEntries ? `entries=${lb.data.length}>=${step.expect.minEntries}✓` : `✗ entries=${lb.data.length}`);
                    }
                    const ok = c.every(s => s.includes('✓'));
                    if (!ok) result.pass = false;
                    logStep(result, 'leaderboard', ok, c.length ? c.join(', ') : `${lb.data.length} entries`);
                    break;
                }

                case 'sync': {
                    send({ type: 'sync' });
                    const ts = await waitMsg('timeSync');
                    const c = [];
                    if (step.expect) {
                        if (step.expect.waveNumber !== undefined) c.push(ts.data.waveNumber === step.expect.waveNumber ? `wave=${ts.data.waveNumber}✓` : `✗ wave=${ts.data.waveNumber}`);
                        if (step.expect.hasBoss !== undefined) c.push((ts.data.boss !== null) === step.expect.hasBoss ? `boss✓` : `✗ boss=${ts.data.boss}`);
                    }
                    const ok = c.every(s => s.includes('✓'));
                    if (!ok) result.pass = false;
                    logStep(result, 'sync', ok, c.length ? c.join(', ') : `wave=${ts.data.waveNumber} boss=${ts.data.boss !== null}`);
                    break;
                }

                case 'wait':
                    await sleep(step.ms || 1000);
                    logStep(result, 'wait', true, `${step.ms||1000}ms`);
                    break;

                default:
                    logStep(result, step.action, false, 'UNKNOWN');
            }
        } catch (e) {
            logStep(result, step.action, false, `EXC: ${e.message}`);
            result.pass = false;
        }
    }

    console.log(`  ${result.pass ? '✅ PASS' : '❌ FAIL'}`);
    return result;
}

async function main() {
    let files = process.argv.slice(2);
    if (files.length === 0) {
        const d = path.join(__dirname, 'scenarios');
        if (fs.existsSync(d)) fs.readdirSync(d).filter(f => f.endsWith('.json')).forEach(f => files.push(path.join(d, f)));
    }
    if (!files.length) { console.log('Usage: node runner.js [scenarios/*.json]'); process.exit(1); }

    console.log(`Testing against ${SERVER}`);

    const all = [];
    for (const f of files) {
        const list = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const sc of (Array.isArray(list) ? list : [list])) {
            all.push(await runScenario(sc));
            await sleep(200);
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    let pass = 0, fail = 0;
    for (const r of all) {
        if (r.pass) pass++; else fail++;
        console.log(`${r.pass ? '✅' : '❌'} ${r.name}`);
        for (const s of r.steps) console.log(`   ${s.result.startsWith('PASS') ? '✓' : '✗'} ${s.step}: ${s.result}`);
    }
    console.log(`\nTotal: ${all.length} | Pass: ${pass} | Fail: ${fail}`);
    try { ws.close(); } catch(e) {}
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
