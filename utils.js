const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const ECPair = ECPairFactory(ecc);

// 初始化 bitcoinjs-lib 的 ECC 库
bitcoin.initEccLib(ecc);

// Buffer 转 Hex
const bufferToHex = (buffer) => Buffer.from(buffer).toString('hex');

// Hex 转 Buffer
const hexToBuffer = (hex) => Buffer.from(hex, 'hex');

// 将 satoshi 转换为 BTC
const satoshiToBTC = (satoshi) => satoshi / 100000000;

// 将 BTC 转换为 satoshi (重命名为 btcToSats 以匹配使用)
const btcToSats = (btc) => Math.floor(btc * 100000000);

// 从 WIF 格式私钥创建密钥对
const createFromWIF = (wif, network = 'mainnet') => {
    const networkConfig = network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
    return ECPair.fromWIF(wif, networkConfig);
};

module.exports = {
    bufferToHex,
    hexToBuffer,
    satoshiToBTC,
    btcToSats,
    createFromWIF,
    bitcoin,
    ECPair
}; 