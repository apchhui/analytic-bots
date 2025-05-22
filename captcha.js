const EventEmitter = require('events');
const sharp = require('sharp');
const colorMap = require('./utils/captcha/colors.json');

class FlayerCaptcha extends EventEmitter {
    constructor(bot, options = {}) {
        super();
        this.bot = bot;
        this.isStopped = options.isStopped || false;
        this.minCardsToRender = options.minCardsToRender || 6;
        this.expectedMapIds = new Set();
        this.pendingMapData = new Map(); // Buffer for pending map data
        this.initializations();

        this.yaws = { "2": '1', "3": '2', "5": '3', "0": '4' };
    }

    stop() { this.updateState(true); }
    resume() { this.updateState(false); }

    updateState(isStopped) {
        if (this.isStopped !== isStopped) {
            this.isStopped = isStopped;
            this.setDefaultSettings();
        }
    }

    getForwardVector() {
        const yaw = this.bot.entity.yaw;
        return {
            x: -Math.sin(yaw),
            y: 0,
            z: -Math.cos(yaw)
        };
    }

    setDefaultSettings() {
        this.img = {
            maps: new Map(),
            images: [],
            x: [], y: [], z: [],
            yaw: null,
            count: 0
        };
        this.keys = this.getCorrectKeys();
        this.expectedMapIds.clear();
        this.pendingMapData.clear();
    }

    isNotSupportedVersion() {
        if (this.bot.registry.version['<=']('1.13.1') || this.bot.registry.version['>=']('1.20.5')) {
            console.error(`Unsupported bot version: ${this.bot.version}`);
            this.stop();
        }
    }

    getCorrectKeys() {
        if (this.bot.registry.version['<=']('1.13.2')) {
            return { keyRotate: 7, keyItem: 6 };
        } else if (this.bot.registry.version['<=']('1.16.5')) {
            return { keyRotate: 8, keyItem: 7 };
        }
        return { keyRotate: 9, keyItem: 8 };
    }

    isFilledMap(itemId) {
        return this.bot.registry.items[itemId]?.name === 'filled_map';
    }

    isFrame(entityType) {
        const frames = new Set(['item_frame', 'item_frames', 'glow_item_frame']);
        const entityName = this.bot.registry.entities[entityType]?.name;
        return frames.has(entityName);
    }

    initializations() {
        this.debugMapDistances = [];

        this.bot._client.on('login', () => {
            this.isNotSupportedVersion();
            if (this.isStopped) return;
            this.setDefaultSettings();
        });

        this.bot._client.on('packet', async (packet) => {
            if (!packet || this.isStopped) return;

            const { itemDamage, data, item } = packet;

            if (data && typeof itemDamage === 'number') {
                if (this.expectedMapIds.has(itemDamage)) {
                    this.img.maps.set(itemDamage, data);
                } else {
                    this.pendingMapData.set(itemDamage, data);
                }
            } else if (this.isFilledMap(item?.itemId)) {
                const idMap = item.nbtData ? item.nbtData.value.map.value : 0;
                const imgBuf = await this.takeImgBuf(idMap);
                if (!imgBuf) return;
                this.img.images.push([{ x: 0, y: 0, z: 0 }, imgBuf, 0]);
                this.img.count++;
                if (this.img.count >= this.minCardsToRender) this.createCaptchaImage();
            }
        });

        this.bot._client.on('entity_metadata', async ({ entityId, metadata }) => {
            if (this.isStopped) return;

            const entity = this.bot.entities[entityId];
            if (!entity) return;

            const { entityType, position } = entity;
            if (!this.isFrame(entityType)) return;

            const botPos = this.bot.entity.position;
            const relative = position.offset(-botPos.x, -botPos.y, -botPos.z);
            const dot = this.getForwardVector().dot(relative);

            const distance = relative.distanceTo({ x: 0, y: 0, z: 0 });
            if (dot < 0.5 || distance > 6) return;

            const itemData = metadata.find(v => v.key === this.keys.keyItem)?.value;
            if (!this.isFilledMap(itemData?.itemId)) return;

            const idMap = itemData.nbtData.value.map.value;
            this.expectedMapIds.add(idMap);

            if (this.pendingMapData.has(idMap)) {
                this.img.maps.set(idMap, this.pendingMapData.get(idMap));
                this.pendingMapData.delete(idMap);
            }

            let imgBuf;
            try {
                imgBuf = await this.takeImgBuf(idMap);
            } catch (e) {
                return;
            }
            if (!imgBuf) return;

            const rotate = metadata.find(v => v.key === this.keys.keyRotate)?.value || 0;
            this.img.images.push([position, imgBuf, rotate]);
            this.img.count++;

            this.debugMapDistances.push({
                idMap,
                x: position.x.toFixed(1),
                y: position.y.toFixed(1),
                z: position.z.toFixed(1),
                distance: distance.toFixed(2)
            });

            if (this.img.count >= this.minCardsToRender) {
                this.createCaptchaImage();

                console.log('\n📊 Сводка по картам:');
                console.table(this.debugMapDistances, ['idMap', 'x', 'y', 'z', 'distance']);
            }
        });
    }


    async takeImgBuf(idMap) {
        let imgBuf;
        const start = Date.now();
        const timeout = 10000; // Increased to 10s timeout

        console.log(`⏳ Ожидание буфера карты ${idMap}...`);

        while (!imgBuf && !this.isStopped) {
            imgBuf = this.img.maps.get(idMap);
            if (imgBuf) break;
            if (Date.now() - start > timeout) {
                console.warn(`⚠️ Таймаут получения буфера карты ${idMap}`);
                break;
            }
            await this.sleep(100);
        }

        return imgBuf ? this.getImgBuf(imgBuf) : null;
    }

    async createCaptchaImage() {
        if (this.isStopped || this.img.count < this.minCardsToRender) return;

        try {
            const readImages = await Promise.all(
                this.img.images.map(([_, imgBuf, rotate]) =>
                    sharp(imgBuf, { raw: { width: 128, height: 128, channels: 4 } })
                        .rotate(90 * rotate)
                        .png()
                        .toBuffer()
                )
            );

            const totalWidth = 128 * readImages.length;
            const height = 128;

            const composites = readImages.map((imageBuffer, i) => ({
                input: imageBuffer,
                left: i * 128,
                top: 0
            }));

            const baseImage = sharp({
                create: {
                    width: totalWidth,
                    height: height,
                    channels: 4,
                    background: { r: 255, g: 255, b: 255, alpha: 1 }
                }
            }).png();

            const image = baseImage.composite(composites);

            this.setDefaultSettings();
            this.emit('success', image);
        } catch (e) {
            console.error('❌ Ошибка при создании капчи:', e);
        }
    }

    createCoordinateMappingAndValue(values, type = false) {
        const sortOrder = !type && (this.img.yaw == 1 || this.img.yaw == 2) ? (a, b) => a - b : (a, b) => b - a;
        const uniqueValues = [...new Set(values)];
        const sortValues = uniqueValues.sort(sortOrder);

        const maxValue = sortValues[0];
        const minValue = sortValues[sortValues.length - 1];

        const value = Math.abs(maxValue - minValue) + 1;
        const mapping = new Map(sortValues.map((val, index) => [val, index * 128]));

        return { mapping, value: value * 128 };
    }

    getImgBuf(buf) {
        const imgBuf = new Uint8ClampedArray(65536);
        const cache = new Map();

        buf.forEach((color, i) => {
            const colorArr = cache.get(color) || colorMap[color];
            cache.set(color, colorArr);
            imgBuf.set(colorArr, i * 4);
        });

        return imgBuf;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = FlayerCaptcha;