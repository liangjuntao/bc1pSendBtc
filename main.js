const bitcoin = require('bitcoinjs-lib');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const ECPair = ECPairFactory(ecc);

// 初始化 bitcoinjs-lib 的 ECC 库
bitcoin.initEccLib(ecc);

// 读取配置文件和地址文件
const configFile = path.join(__dirname, 'config.json');
const addressFile = path.join(__dirname, 'addresses.txt');

const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const addresses = fs.readFileSync(addressFile, 'utf8').split('\n').map(line => line.trim()).filter(line => line !== '');

// 获取UTXO（未花费交易输出）
async function getUTXOs(address) {
  try {
    console.log('正在获取地址的UTXO:', address);
    const response = await axios.get(`https://mempool.space/api/address/${address}/utxo`);
    console.log('UTXO 响应数据:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('获取UTXO时出错:', error.message);
    throw error;
  }
}

// 获取交易的手续费
async function getFeeRate() {
  // 尝试从配置文件读取费率
  if (config.feeRate && typeof config.feeRate === 'number' && config.feeRate > 0) {
    console.log('使用配置文件中的费率:', config.feeRate, 'sat/vB');
    return config.feeRate;
  } else {
    // 如果配置文件中没有有效费率，则从 API 获取
    console.log('配置文件中未设置有效费率，从 API 获取推荐费率...');
    try {
      const response = await axios.get('https://mempool.space/api/v1/fees/recommended');
      console.log('从 API 获取到的推荐费率:', response.data.fastestFee, 'sat/vB');
      return response.data.fastestFee;
    } catch (error) {
      console.error('从 API 获取费率失败:', error.message);
      throw new Error('无法获取交易费率'); // 如果 API 也失败，则抛出错误
    }
  }
}

// 获取交易详情
async function getTxDetails(txid) {
  try {
    const response = await axios.get(`https://mempool.space/api/tx/${txid}`);
    return response.data;
  } catch (error) {
    console.error('获取交易详情时出错:', error.message);
    throw error;
  }
}

// 构建并签名批量转账交易
async function createTransaction(privateKey, sendAmountBTC) {
  // 创建一个比特币钱包（由WIF私钥生成）
  const network = bitcoin.networks.bitcoin;  // 使用比特币主网
  const keyPair = ECPair.fromWIF(privateKey, network);
  
  // 获取公钥并创建原生隔离见证 (P2WPKH) 输出
  const { address } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });

  console.log('\n=== 交易详情 ===');
  console.log('发送地址 (P2WPKH):', address);
  const utxos = await getUTXOs(address);  // 获取当前钱包的UTXO
  
  if (!utxos || utxos.length === 0) {
    throw new Error('没有找到可用的UTXO');
  }

  const feeRate = await getFeeRate();  // 获取当前的手续费
  console.log('当前费率:', feeRate, 'sat/vB');
  
  let inputAmount = 0;
  const psbt = new bitcoin.Psbt({ network });

  // 选择UTXO
  for (const utxo of utxos) {
    console.log('\n处理UTXO:', utxo.txid);
    console.log('UTXO金额:', utxo.value, 'satoshis');
    
    // 获取交易详情以获取scriptPubKey
    const txDetails = await getTxDetails(utxo.txid);
    const output = txDetails.vout[utxo.vout];
    
    if (!output || !output.scriptpubkey) {
      console.error('无法获取输出脚本:', utxo);
      continue;
    }

    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: Buffer.from(output.scriptpubkey, 'hex'),
        value: utxo.value,
      },
      // P2WPKH 不需要 tapInternalKey
    });
    inputAmount += utxo.value;
  }
  
  if (psbt.data.inputs.length === 0) {
    throw new Error('没有成功添加任何有效的 UTXO 输入，请检查 scriptpubkey 的提取逻辑');
  }


  console.log('\n=== 金额计算 ===');
  console.log('总输入金额:', inputAmount, 'satoshis');

  const totalAmountInSatoshis = Math.floor(sendAmountBTC * 100000000);  // 将BTC金额转换为satoshis
  
  // 估算交易大小：
  // - 每个 P2WPKH 输入约 68 vBytes 
  // - 每个 P2WPKH/P2SH 输出约 31-34 vBytes (我们用 34 作为保守估计)
  // - 基础交易开销约 10.5 vBytes
  const inputCount = utxos.length;
  const outputCount = addresses.length + 1; // +1 为找零输出
  const inputSize = inputCount * 68; 
  const outputSize = outputCount * 34; 
  const baseSize = 10.5;
  const estimatedSize = Math.ceil(inputSize + outputSize + baseSize);
  const estimatedFee = Math.ceil(feeRate * estimatedSize);

  console.log('\n=== 交易费用估算 (P2WPKH) ===');
  console.log('预估交易大小:', estimatedSize, 'vBytes');
  console.log('- 输入大小:', inputSize, 'vBytes', `(${inputCount} 个输入)`);
  console.log('- 输出大小:', outputSize, 'vBytes', `(${addresses.length} 个接收地址 + 1 个找零)`);
  console.log('- 基础大小:', baseSize, 'vBytes');
  console.log('费率:', feeRate, 'sat/vB');
  console.log('预估手续费:', estimatedFee, 'satoshis');

  console.log('\n=== 发送详情 ===');
  console.log('每个地址发送金额:', totalAmountInSatoshis, 'satoshis');
  console.log('接收地址数量:', addresses.length);

  // 将接收者的地址和金额添加到交易中
  const totalAddressesAmount = addresses.length * totalAmountInSatoshis;
  console.log('总发送金额:', totalAddressesAmount, 'satoshis');
  console.log('总支出:', totalAddressesAmount + estimatedFee, 'satoshis (发送金额 + 手续费)');
  console.log('可用余额:', inputAmount, 'satoshis');

  if (inputAmount < totalAddressesAmount + estimatedFee) {
    throw new Error(`余额不足以支付转账金额和手续费:\n` +
      `- 需要金额: ${totalAddressesAmount + estimatedFee} satoshis\n` +
      `  • 发送金额: ${totalAddressesAmount} satoshis\n` +
      `  • 手续费: ${estimatedFee} satoshis\n` +
      `- 可用余额: ${inputAmount} satoshis\n` +
      `- 差额: ${(totalAddressesAmount + estimatedFee) - inputAmount} satoshis`);
  }

  addresses.forEach(recipientAddress => {
    psbt.addOutput({
      address: recipientAddress,
      value: totalAmountInSatoshis
    });
  });

  // 计算找零金额并添加找零输出
  const changeAmount = inputAmount - totalAddressesAmount - estimatedFee;
  if (changeAmount > 546) { // 避免粉尘找零
    console.log('\n找零金额:', changeAmount, 'satoshis');
    psbt.addOutput({
      address: address, // 找零发送回 P2WPKH 地址
      value: changeAmount
    });
  }

  // 对所有输入进行签名 (使用 signInput)
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    psbt.signInput(i, keyPair);
  }
  
  // 定义签名验证函数
  const validator = (pubkey, msghash, signature) =>
    ecc.verify(msghash, pubkey, signature);

  // 验证所有输入是否已签名 (传入验证函数)
  psbt.validateSignaturesOfAllInputs(validator);
  
  // 完成所有输入的签名
  psbt.finalizeAllInputs();

  // 构建并返回交易
  const tx = psbt.extractTransaction();
  return tx.toHex();
}

// 广播交易到比特币网络
async function broadcastTransaction(txHex) {
  try {
    const response = await axios.post('https://mempool.space/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' },
    });
    return response.data;
  } catch (error) {
    console.error('广播交易时出错:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// 主程序
(async () => {
  try {
    console.log('开始创建交易...');
    const txHex = await createTransaction(config.privateKey, config.sendAmountBTC);
    console.log('交易已创建:', txHex);

    console.log('正在广播交易...');
    const broadcastResponse = await broadcastTransaction(txHex);
    console.log('交易广播成功:', broadcastResponse);
  } catch (error) {
    console.error('错误:', error);
  }
})();
