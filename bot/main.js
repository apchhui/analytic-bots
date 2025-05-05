const mineflayer = require('mineflayer')
const axios = require('axios')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// node main.js beliberdanka 30
function saveItemDebug(item, index = 0) {
    const filePath = `mfdata/debug_item_${index}.json`
    fs.writeFileSync(filePath, JSON.stringify(item, null, 2), 'utf-8')
    // console.log(`📄 Предмет сохранён в ${filePath}`)
}

const username = process.argv[2]
const categorySlot = parseInt(process.argv[3], 10)
const anarchy = parseInt(process.argv[4], 10)

if (!username || isNaN(categorySlot) || isNaN(anarchy)) {
    console.error('❌ Использование: node main.js <ник> <номер_слота> <анка>')
    process.exit(1)
}


const host = 'play.funtime.su'

bot = mineflayer.createBot({
    host: host,
    username: username,
    version: '1.18'
})

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
    fs.appendFileSync(hashFilePath, hash + '\n')
}

function hashItem(item) {
    const str = `${item.name}-${item.count}-${item.seller}-${item.price}`
    return crypto.createHash('sha256').update(str).digest('hex')
}

let auctionOpened = false
let categorySelected = false

let waklState = true

bot.on('windowOpen', async function (window) {
    const title = window.title

    if (!auctionOpened && title.includes('Аукционы')) {
        auctionOpened = true
        await bot.simpleClick.leftMouse(52)
        console.log('✅ Открыт раздел аукциона')
        return
    } else if (!categorySelected && title.includes('Выбор категории')) {
        categorySelected = true
        await bot.simpleClick.leftMouse(categorySlot)
        console.log('✅ Выбрана категория')
        return
    }

    if (categorySelected && auctionOpened) {
        for (let i = 0; i < 45; i++) {
            const item = window.slots[i];
            if (item) {
                const nbt = item.nbt
                if (!nbt) continue;

                const loreTag = nbt.value?.display?.value?.Lore?.value?.value
                if (!Array.isArray(loreTag)) continue;

                let seller = ''
                let price = ''

                for (const jsonStr of loreTag) {
                    const msg = JSON.parse(jsonStr)

                    if (msg.extra) {
                        const fullText = msg.extra.map(e => e.text).join('')

                        if (fullText.includes('Прoдaвeц:')) {
                            seller = msg.extra[msg.extra.length - 1].text.trim()
                        }

                        if (fullText.includes('Ценa')) {
                            price = msg.extra[msg.extra.length - 1].text.trim()
                        }
                    }
                }

                const name = item.name
                const count = item.count
                const numericPrice = parseInt(price.replace(/[^0-9]/g, ''), 10)
                // console.log(`[DEBUG] ${name}, ${count}, ${seller}, ${numericPrice}`)

                const itemHash = hashItem({
                    name,
                    count,
                    seller,
                    price: numericPrice
                })
                // console.log(`[DEBUG HASH] ${itemHash} — уже был? ${sentItems.has(itemHash)}`)
                saveItemDebug(item, i)
                if (sentItems.has(itemHash)) {
                    continue
                }

                sentItems.add(itemHash)
                saveHash(itemHash)

                try {
                    await axios.post('http://localhost:8000/item/', {
                        item: name,
                        count: count,
                        seller: seller,
                        price: numericPrice
                    })
                    // console.log(`✅ Отправлен новый предмет: ${name}`)
                } catch (err) {
                    console.log(`❌ Ошибка при отправке ${name}: ${err}`)
                }
            }
        }
        categorySelected = false
        auctionOpened = false
        bot.closeWindow(window)
        if(waklState == true) { bot.setControlState('forward', true);
            waklState = false
        } else if (waklState == false) {bot.setControlState('back', true);
            waklState = true
        }
        await sleep(10000)
        bot.clearControlStates()
        bot.chat('/ah')
        const used = process.memoryUsage();
        console.log(`[MEMORY] Heap: ${(used.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(used.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    }
})

bot.on('disconnect', function (packet) {
    console.log('disconnected: ' + packet.reason)
})
