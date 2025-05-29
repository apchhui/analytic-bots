const mineflayer = require('mineflayer')
const mineflayerViewer = require('prismarine-viewer').mineflayer
const axios = require('axios')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const Vec3 = require('vec3')
const colorMap = require('./utils/captcha/colors.json')
const FlayerCaptcha = require('flayercaptcha');
const { getValueFromType } = require('three/src/nodes/core/NodeUtils.js')

function saveItemDebug(item, index = 0) {
    const filePath = `mfdata/debug_item_${index}.json`
    fs.writeFileSync(filePath, JSON.stringify(item, null, 2), 'utf-8')
}

const username = process.argv[2]
const categorySlot = parseInt(process.argv[3], 10)
const anarchy = parseInt(process.argv[4], 10)

if (!username || isNaN(categorySlot) || isNaN(anarchy)) {
    console.error('❌ Использование: node main.js <ник> <номер_слота> <анка>')
    process.exit(1)
}

const host = 'play.funtime.su'

const bot = mineflayer.createBot({
    host: host,
    username: username,
    version: '1.18'
})

const directions = new Map([
  ['3 2', 'up'],
  ['3 -2', 'down'],
  ['3 0', 'south'],
  ['2 0', 'west'],
  ['0 0', 'north'],
  ['5 0', 'east']
]);

function getViewDirection(yaw, pitch) {
  const key = `${Math.round(yaw)} ${Math.round(pitch)}`;
  return directions.get(key);
}

let BotViewDirection = null;
let ReserveBotDirection = null;
let saved = false;

const captcha = new FlayerCaptcha(bot);

captcha.on('success', async (imageSharp, viewDirection) => {
  while (BotViewDirection === null || ReserveBotDirection === null) {
    await sleep(10);
  }

  if (saved) return;

  if (viewDirection === ReserveBotDirection) {
    const filePath = `maps/captcha/captcha_${bot.username}.png`;
    try {
      await imageSharp.toFile(filePath);
      console.log(`✔ Saved correct CAPTCHA at ${filePath}`);
      saved = true;
    } catch (err) {
      console.error('❌ Error saving image:', err);
    }
  } else {
    console.log(`✘ Ignored CAPTCHA (direction ${viewDirection} ≠ target)`);
  }
});

bot.once('login', async () => {
  mineflayerViewer(bot, { port: 3000 });

  await sleep(3000);

  const yaw = bot.entity.yaw;
  const pitch = bot.entity.pitch;

  const mainDir = getViewDirection(yaw, pitch);
  if (!mainDir) {
    console.warn(`⚠ Не удалось определить направление бота (Yaw: ${yaw}, Pitch: ${pitch})`);
    return;
  }

  BotViewDirection = mainDir;

  // Зеркальное направление:
  if (mainDir === 'north') ReserveBotDirection = 'south';
  else if (mainDir === 'south') ReserveBotDirection = 'north';
  else if (mainDir === 'east') ReserveBotDirection = 'west';
  else if (mainDir === 'west') ReserveBotDirection = 'east';
  else ReserveBotDirection = mainDir; // для up/down оставить как есть

  console.log(`✔ BotViewDirection: ${BotViewDirection}, Reserve: ${ReserveBotDirection}`);
});



function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToAPI(data, point) {
    try {
        await axios.post(`http://localhost:8000/${point}/`, {
            text: data
        })
        console.log('✅ Сообщение отправлено в FastAPI:', data)
    } catch (err) {
        console.error('❌ Ошибка при отправке в FastAPI:', err.message)
    }
}

bot.on('message', async function (message) {
    const msg = message.toString()
    console.log(msg)
    if (msg.includes('⇨')) {
        await sendToAPI(msg, 'message')
    }
})

bot.once('spawn', async function() {
    console.log(`Бот ${bot.username} успешно присоединился к серверу!`)
    bot.chat(`/an${anarchy}`)
    await sleep(11000);
    bot.chat('/ah')
})

const hashesDir = path.join(__dirname, 'hashes')
const hashFilePath = path.join(hashesDir, `${username}_${host.replace(/\W/g, '_')}.txt`)
const sentItems = new Set()

if (!fs.existsSync(hashesDir)) fs.mkdirSync(hashesDir)
if (fs.existsSync(hashFilePath)) {
    const lines = fs.readFileSync(hashFilePath, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
        sentItems.add(line)
    }
    console.log(`🔄 Загружено ${sentItems.size} ранее отправленных предметов.`)
}

function saveHash(hash) {
    sentItems.add(hash)
    const allHashes = Array.from(sentItems)
    if (allHashes.length > 70) {
        const lastHashes = allHashes.slice(-70)
        fs.writeFileSync(hashFilePath, lastHashes.join('\n') + '\n', 'utf-8')
        sentItems.clear()
        for (const h of lastHashes) sentItems.add(h)
    } else {
        fs.appendFileSync(hashFilePath, hash + '\n')
    }
}

function hashItem(item) {
    const str = `${item.name}-${item.count}-${item.seller}-${item.price}`
    return crypto.createHash('sha256').update(str).digest('hex')
}

let auctionOpened = false
let categorySelected = false

let waklState = true

function getReadableItemName(item) {
    try {
        const nameJson = item?.nbt?.value?.display?.value?.Name?.value;
        if (!nameJson) return null;

        const parsed = JSON.parse(nameJson);

        if (Array.isArray(parsed.extra)) {
            return parsed.extra.map(part => part.text || '').join('');
        } else {
            return parsed.text || '';
        }
    } catch (e) {
        console.error('Ошибка при разборе имени предмета:', e.message);
        return null;
    }
}


bot.on('windowOpen', async function (window) {
    const title = window.title;

    if (!auctionOpened && title.includes('Аукционы')) {
        auctionOpened = true;
        await bot.simpleClick.leftMouse(52);
        console.log('✅ Открыт раздел аукциона');
        return;
    } else if (!categorySelected && title.includes('Выбор категории')) {
        categorySelected = true;
        await bot.simpleClick.leftMouse(categorySlot);
        console.log('✅ Выбрана категория');
        return;
    }

    if (categorySelected && auctionOpened) {
        for (let i = 0; i < 45; i++) {
            const item = window.slots[i];
            if (item) {
                const nbt = item.nbt;
                if (!nbt) continue;

                const loreTag = nbt.value?.display?.value?.Lore?.value?.value;
                if (!Array.isArray(loreTag)) continue;

                let seller = null;
                let price = null;

                for (const jsonStr of loreTag) {
                    const msg = JSON.parse(jsonStr);

                    if (msg.extra) {
                        const fullText = msg.extra.map(e => e.text).join('');

                        if (fullText.includes('Прoдaвeц:')) {
                            seller = msg.extra[msg.extra.length - 1].text.trim();
                        }

                        if (fullText.includes('Ценa')) {
                            price = msg.extra[msg.extra.length - 1].text.trim();
                        }
                    }
                }

                const name = item.name ?? null;
                const count = item.count ?? null;
                const numericPrice = price ? parseInt(price.replace(/[^0-9]/g, ''), 10) : null;

                const itemHash = hashItem({
                    name,
                    count,
                    seller,
                    price: numericPrice
                });

                saveItemDebug(item, i);
                if (sentItems.has(itemHash)) {
                    continue;
                }

                sentItems.add(itemHash);
                saveHash(itemHash);
                const Iname = getReadableItemName(item);
                try {
                    const payload = {
                        item: name ?? undefined,
                        count: count ?? undefined,
                        seller: seller ?? undefined,
                        price: numericPrice ?? undefined,
                        name: Iname ?? undefined,
                        rname: item.displayName ?? undefined
                    };
                    
                    await axios.post('http://localhost:8000/item/', payload);
                } catch (err) {
                    console.log(`❌ Ошибка при отправке ${name}: ${err}`);
                }
            }
        }

        categorySelected = false;
        auctionOpened = false;
        bot.closeWindow(window);
        if (waklState == true) {
            bot.setControlState('forward', true);
            waklState = false;
        } else {
            bot.setControlState('back', true);
            waklState = true;
        }
        await sleep(10000);
        bot.clearControlStates();
        console.log(username);
        bot.chat('/ah');
        const used = process.memoryUsage();
        console.log(`[MEMORY] Heap: ${(used.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(used.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    }
});


bot.on('disconnect', function () {
    console.log('disconnected')
    process.exit(1)
})

bot.on('kick', function () {
    console.log('kicked')
    process.exit(1)
})
