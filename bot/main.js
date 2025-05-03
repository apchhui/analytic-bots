const mineflayer = require('mineflayer')
const axios = require('axios')
const webInv = require('mineflayer-web-inventory')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const botUsername = 'beliberdanka'
const host = 'play.funtime.su'

bot = mineflayer.createBot({
    host: host,
    username: botUsername,
    version: '1.18'
})

webInv(bot)

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
    bot.chat('/an222')
    await sleep(11000);
    bot.chat('/ah')
})

const hashesDir = path.join(__dirname, 'hashes')
const hashFilePath = path.join(hashesDir, `${botUsername}_${host.replace(/\W/g, '_')}.txt`)
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

bot.on('windowOpen', async function (window) {
    const title = window.title
    console.log(title)

    if (!auctionOpened && title.includes('Аукционы')) {
        auctionOpened = true
        await bot.simpleClick.leftMouse(52)
        console.log('✅ Открыт раздел аукциона')
        return
    } else if (!categorySelected && title.includes('Выбор категории')) {
        categorySelected = true
        await bot.simpleClick.leftMouse(30)
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
                console.log(`[DEBUG] ${name}, ${count}, ${seller}, ${numericPrice}`)

                const itemHash = hashItem({
                    name,
                    count,
                    seller,
                    price: numericPrice
                })
                console.log(`[DEBUG HASH] ${itemHash} — уже был? ${sentItems.has(itemHash)}`)

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
                    console.log(`✅ Отправлен новый предмет: ${name}`)
                } catch (err) {
                    console.log(`❌ Ошибка при отправке ${name}: ${err}`)
                }
            }
        }
    }
})

bot.on('disconnect', function (packet) {
    console.log('disconnected: ' + packet.reason)
})
