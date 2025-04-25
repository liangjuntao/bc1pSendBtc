const bitcoin = require('bitcoinjs-lib');
const wif = require('wif');
const ecc = require('tiny-secp256k1');
const fs = require('fs');
const axios = require('axios');
const readline = require('readline'); // 引入 readline 模块
const crypto = require('crypto');
const ECPair = require('ecpair').default(ecc); // 尝试通过 .default 访问工厂函数

// 为 bitcoinjs-lib 初始化 ECC 库
bitcoin.initEccLib(ecc);

// 读取配置文件
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const addresses = fs.readFileSync('./addresses.txt', 'utf8').split('\n').filter(Boolean);
const amountToSendBTC = config.sendAmountBTC || 0.0001; // 从配置读取金额，提供默认值
const amountInSats = Math.floor(amountToSendBTC * 100000000);

// Mempool API 基础URL
const MEMPOOL_API = config.network === 'mainnet'
    ? 'https://mempool.space/api'
    : 'https://mempool.space/testnet/api';

// --- 辅助函数（转换） ---
// Buffer 转 Hex
const bufferToHex = (buffer) => Buffer.from(buffer).toString('hex');
// Hex 转 Uint8Array
const hexToBytes = (hex) => secp.utils.hexToBytes(hex);
// Buffer 转 Uint8Array
const bufferToBytes = (buffer) => Uint8Array.from(buffer);
// Uint8Array 转 Buffer
const bytesToBuffer = (bytes) => Buffer.from(bytes);
// --- End 辅助函数 ---

// --- 辅助函数 ---
async function getUtxos(address) {
    try {
        const { data } = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`);
        console.log(`获取到 ${address} 的 ${data.length} 个 UTXO`);
        return data;
    } catch (error) {
        throw new Error(`获取UTXO失败 (${address}): ${error.message}`);
    }
}

async function getTxHex(txid) {
    try {
        const { data } = await axios.get(`${MEMPOOL_API}/tx/${txid}/hex`);
        return data;
    } catch (error) {
        throw new Error(`获取交易Hex失败 (${txid}): ${error.message}`);
    }
}

async function getUtxoDetails(utxo) {
    try {
        const { data } = await axios.get(`${MEMPOOL_API}/tx/${utxo.txid}`);
        return data;
    } catch (error) {
         throw new Error(`获取 UTXO 详情失败 (${utxo.txid}): ${error.message}`);
    }
}

async function getFeeRate() {
    try {
        const { data } = await axios.get(`${MEMPOOL_API}/v1/fees/recommended`);
        // 使用中等优先级费率，如果需要更快确认，可以使用 fastestFee
        return data.halfHourFee || data.fastestFee || config.feeRate;
    } catch (error) {
        console.warn(`获取推荐费率失败，使用配置文件中的费率: ${config.feeRate}`);
        return config.feeRate; // 如果API失败，使用配置文件中的费率
    }
}

async function broadcastTx(txHex) {
    try {
        const { data } = await axios.post(`${MEMPOOL_API}/tx`, txHex);
        return data; // 返回交易ID
    } catch (error) {
        // 尝试解析更详细的错误信息
        const errorMessage = error.response?.data || error.message;
        throw new Error(`广播交易失败: ${errorMessage}`);
    }
}

// 估算 P2TR 交易的虚拟大小 (vBytes)
function estimateTxVbytes(inputCount, outputCount) {
    const base = 10.5; // 基础大小 (版本, locktime, 输入/输出计数器)
    const inputSize = 57.5; // P2TR 输入大小
    const outputSize = 43; // P2TR 输出大小
    return Math.ceil(base + inputCount * inputSize + outputCount * outputSize);
}

// --- 主批量发送逻辑 ---
async function batchSend() {
    // 在函数开始时动态导入 @noble/curves/secp256k1
    const secpModule = await import('@noble/curves/secp256k1'); // 导入模块
    const secp = secpModule; // 使用整个模块对象，访问子对象

    // 创建 readline 接口
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    // 将确认逻辑包装成 Promise
    const confirmBroadcast = (question) => {
        return new Promise(resolve => {
            rl.question(question, (answer) => {
                resolve(answer.trim().toUpperCase());
            });
        });
    };

    try { // 将主要逻辑包裹在 try...finally 中以确保 readline 关闭
        console.log(`准备批量发送 ${amountToSendBTC} BTC 到 ${addresses.length} 个地址...`);
        const feeRate = await getFeeRate();
        console.log(`使用费率: ${feeRate} sat/vB`);

        // 1. 初始化密钥和地址
        let privateKeyBytes; // 存储 Uint8Array 格式的私钥
        let publicKeyBytes; // 存储 Uint8Array 格式的公钥 (x-only)
        try {
            // bitcoinjs-lib 的 fromWIF 返回 ECPairInterface，我们只需要私钥 Buffer
            const network = bitcoin.networks[config.network];
            const keyPair = ECPair.fromWIF(config.privateKey, network); // 使用初始化后的 ECPair
            privateKeyBytes = bufferToBytes(keyPair.privateKey); // 转换为 Uint8Array
            // 恢复验证，使用正确的路径
            if (!secp.secp256k1.utils.isValidPrivateKey(privateKeyBytes)) { // 使用 secp.secp256k1.utils
                throw new Error('从 WIF 解码的私钥无效');
            }
            // 从私钥计算 x-only 公钥 (Uint8Array)
            publicKeyBytes = secp.secp256k1.getPublicKey(privateKeyBytes, true).slice(1, 33); // 使用 secp.secp256k1.getPublicKey
        } catch (error) {
            console.error(`WIF私钥处理错误: ${error.message}`);
            return; // 在 finally 中关闭 rl
        }
        // const pubkey = keyPair.publicKey.slice(1, 33); // 旧方式
        const pubkey = publicKeyBytes; // 现在 pubkey 是 Uint8Array

        // 使用 bitcoinjs-lib 计算 P2TR 地址和 scriptPubKey (内部公钥需要 Buffer)
        const payment = bitcoin.payments.p2tr({
            internalPubkey: bytesToBuffer(pubkey), // 转换为 Buffer
            network: bitcoin.networks[config.network]
        });
        const fromAddress = payment.address;
        const expectedScriptPubKeyHex = payment.output.toString('hex'); // 预期的 scriptPubKey
        console.log(`使用发送地址: ${fromAddress}`);
        console.log(`预期 ScriptPubKey: ${expectedScriptPubKeyHex}`);
        console.log(`X-Only PubKey (hex): ${bufferToHex(pubkey)}`);

        // 2. 获取并选择 UTXO
        const utxos = await getUtxos(fromAddress);
        if (!utxos.length) {
            console.error('错误: 发送地址没有可用的 UTXO。');
            return; // 在 finally 中关闭 rl
        }

        const psbt = new bitcoin.Psbt({ network: bitcoin.networks[config.network] });
        let totalInput = 0;
        const selectedUtxos = [];
        const totalAmountToSend = BigInt(amountInSats) * BigInt(addresses.length);
        let estimatedFee = BigInt(0);

        let initialEstimatedFee = BigInt(estimateTxVbytes(1, addresses.length + 1) * feeRate);
        const preliminaryTotalNeeded = totalAmountToSend + initialEstimatedFee;

        console.log(`总发送额: ${totalAmountToSend} sats`);
        console.log(`初步估计手续费: ${initialEstimatedFee} sats`);
        console.log(`初步估计总需求: ${preliminaryTotalNeeded} sats`);

        for (const utxo of utxos) {
            selectedUtxos.push(utxo);
            totalInput += utxo.value;
            estimatedFee = BigInt(estimateTxVbytes(selectedUtxos.length, addresses.length + 1) * feeRate);
            const totalNeeded = totalAmountToSend + estimatedFee;
            console.log(`已选择 ${selectedUtxos.length} 个 UTXO, 总输入: ${totalInput} sats, 估计费用: ${estimatedFee} sats, 总需求: ${totalNeeded} sats`);
            if (BigInt(totalInput) >= totalNeeded) {
                break;
            }
        }

        if (BigInt(totalInput) < totalAmountToSend + estimatedFee) {
            console.error(`错误: 余额不足。需要 ${totalAmountToSend + estimatedFee} sats，但只有 ${totalInput} sats 可用。`);
            return; // 在 finally 中关闭 rl
        }

        // 3. 添加输入到 PSBT
        console.log(`添加 ${selectedUtxos.length} 个输入到交易...`);
        for (const utxo of selectedUtxos) {
             try {
                // 获取 UTXO 的交易详情以获取 scriptPubKey
                const utxoDetails = await getUtxoDetails(utxo);
                const output = utxoDetails.vout[utxo.vout];
                const scriptPubKeyFromApi = output?.scriptpubkey; // 从 API 获取的 script

                if (!scriptPubKeyFromApi) {
                     throw new Error(`无法获取 UTXO ${utxo.txid}:${utxo.vout} 的 scriptpubkey`);
                }
                const scriptPubKeyFromApiHex = Buffer.from(scriptPubKeyFromApi, 'hex').toString('hex'); // 确保是 hex 格式

                console.log(`  - 正在添加 UTXO: ${utxo.txid}:${utxo.vout}`);
                console.log(`    Value: ${utxo.value} sats`);
                console.log(`    Script from API: ${scriptPubKeyFromApiHex}`);

                // !! 验证 scriptPubKey 是否匹配 !!
                if (scriptPubKeyFromApiHex !== expectedScriptPubKeyHex) {
                    console.error(`错误: UTXO ${utxo.txid}:${utxo.vout} 的 ScriptPubKey (${scriptPubKeyFromApiHex}) 与预期 (${expectedScriptPubKeyHex}) 不匹配！`);
                    console.error("这可能意味着该 UTXO 不属于提供的私钥，或者 API 返回了错误的数据。");
                    return; // 终止处理
                }

                psbt.addInput({
                    hash: utxo.txid,
                    index: utxo.vout,
                    witnessUtxo: {
                        script: Buffer.from(scriptPubKeyFromApiHex, 'hex'),
                        value: utxo.value
                    },
                    // tapInternalKey 需要 32 字节 Buffer
                    tapInternalKey: bytesToBuffer(pubkey) // 转换为 Buffer
                });
                console.log(`    UTXO 添加成功。`);

             } catch(error) {
                 console.error(`添加输入 ${utxo.txid}:${utxo.vout} 失败: ${error.message}`);
                 return; // 关键信息获取失败，终止交易构建
             }
        }

        // 4. 添加输出到 PSBT
        console.log(`添加 ${addresses.length} 个输出到交易...`);
        addresses.forEach(address => {
            psbt.addOutput({
                address: address.trim(),
                value: amountInSats
            });
        });

        // 5. 计算精确手续费并添加找零
        const finalFee = estimatedFee;
        const changeValue = BigInt(totalInput) - totalAmountToSend - finalFee;

        console.log(`总输入: ${totalInput} sats`);
        console.log(`总输出 (含找零): ${totalAmountToSend + changeValue} sats`);
        console.log(`最终手续费: ${finalFee} sats`);

        if (changeValue < 0) {
             console.error(`错误: 内部计算错误，找零金额为负 (${changeValue} sats)`);
             return; // 在 finally 中关闭 rl
        }

        if (changeValue >= 546) {
            console.log(`添加找零: ${changeValue} sats 到 ${fromAddress}`);
            psbt.addOutput({
                address: fromAddress,
                value: Number(changeValue)
            });
        } else {
            console.log(`找零金额 ${changeValue} sats 过小，不添加找零输出，将作为额外手续费。`);
        }

        // 6. 签名交易 (使用 @noble/curves/secp256k1)
        console.log("签名交易 (使用 @noble/curves/secp256k1)...");
        try {
            const sighashType = bitcoin.Transaction.SIGHASH_DEFAULT;

            // --- Taproot Key Tweaking Logic (使用 @noble/curves/secp256k1) ---
            let privateKeyToUse = privateKeyBytes; // Uint8Array
            const fullPublicKeyBytes = secp.secp256k1.getPublicKey(privateKeyBytes, true); // 使用 secp.secp256k1.getPublicKey
            if (fullPublicKeyBytes[0] === 3) { // 检查 Y 坐标奇偶性 (0x03)
                console.log("    公钥 Y 坐标为奇数，需要调整私钥进行签名。");
                try {
                    // privateNegate 需要 BigInt，然后转回 Uint8Array
                    const privKeyBigInt = secp.schnorr.utils.bytesToNumberBE(privateKeyBytes); // 使用 secp.schnorr.utils
                    const N = secp.secp256k1.CURVE.n; // 使用 secp.secp256k1.CURVE
                    const tweakedPrivKeyBigInt = (N - privKeyBigInt) % N;
                    privateKeyToUse = secp.schnorr.utils.numberToBytesBE(tweakedPrivKeyBigInt); // 使用 secp.schnorr.utils
                    console.log("    将使用调整后的 Uint8Array 私钥进行签名。");
                } catch (tweakError) {
                    console.error("    调整私钥时出错:", tweakError);
                    throw new Error("无法调整私钥以进行 Taproot 签名。");
                }
            } else {
                console.log("    公钥 Y 坐标为偶数，使用原始 Uint8Array 私钥进行签名。");
            }
            // --- End Taproot Key Tweaking Logic ---

            // 定义 signerXOnlyPublicKey 变量在 try 块外部
            let signerXOnlyPublicKey; // 这个变量似乎不再直接需要，但保留以防万一

            for (let i = 0; i < psbt.inputCount; i++) {
                console.log(`  - 准备为输入 #${i} 计算签名哈希...`);
                // 获取用于签名的哈希 (Sighash) - 这部分逻辑不变，使用 bitcoinjs-lib
                const prevoutScripts = selectedUtxos.map(utxo => psbt.data.inputs[i].witnessUtxo.script);
                const prevoutValues = selectedUtxos.map(utxo => psbt.data.inputs[i].witnessUtxo.value);
                const hashType = sighashType;
                const genesisBlockHash = Buffer.from('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', 'hex');

                let sighashBuffer; // 用于存储 sighash 的 Buffer
                try {
                    const tx = psbt.__CACHE.__TX;
                    const prevoutScript = Buffer.from(prevoutScripts[i]);
                    const prevoutValue = Number(prevoutValues[i]);

                    sighashBuffer = tx.hashForWitnessV1( // 返回 Buffer
                        i,
                        [prevoutScript],
                        [prevoutValue],
                        hashType,
                        genesisBlockHash
                    );
                    console.log(`    输入 #${i} 签名哈希 (Buffer): ${sighashBuffer.toString('hex')}`);
                } catch (hashError) {
                    console.error(`    计算输入 #${i} 的签名哈希时出错:`, hashError);
                    throw new Error(`无法计算输入 #${i} 的签名哈希`);
                }
                const sighashBytes = bufferToBytes(sighashBuffer); // 转换为 Uint8Array 供 Noble 使用

                console.log(`  - 尝试使用 secp.signSchnorr 签名哈希...`);
                // 使用 secp.signSchnorr 进行签名 (异步)
                let schnorrSignatureBytes; // Uint8Array
                try {
                    // secp.schnorr.sign 需要 Uint8Array 格式的 sighash 和私钥
                    // 它内部处理 nonce (auxRand)，无需手动提供
                    schnorrSignatureBytes = await secp.schnorr.sign(sighashBytes, privateKeyToUse); // 使用 secp.schnorr.sign
                    console.log(`    输入 #${i} Schnorr 签名 (Uint8Array): ${schnorrSignatureBytes}`);
                    console.log(`    输入 #${i} Schnorr 签名 (Hex): ${bufferToHex(schnorrSignatureBytes)}`);

                    // 验证签名是否有效 (使用 @noble/curves/secp256k1)
                    console.log("--- 尝试使用 @noble/curves/secp256k1 进行验证 ---");
                    // verify 需要 sighash (hex or bytes), pubkey (hex or bytes), signature (hex or bytes)
                    // 我们使用 x-only pubkey (Uint8Array)
                    const isValid = await secp.schnorr.verify(schnorrSignatureBytes, sighashBytes, pubkey); // 调整参数顺序
                    if (!isValid) {
                         console.error(`  签名验证失败! (使用 @noble/curves/secp256k1)`);
                         console.error(`    Sighash (Hex): ${bufferToHex(sighashBytes)}`);
                         console.error(`    Signature (Hex): ${bufferToHex(schnorrSignatureBytes)}`);
                         console.error(`    X-Only Pubkey (Hex): ${bufferToHex(pubkey)}`);
                         throw new Error(`生成的签名无效`);
                    }
                    console.log(`    签名验证通过 (@noble/curves/secp256k1)`);
                 } catch(signOrVerifyError) {
                    console.error(`    @noble/curves/secp256k1 签名或验证时出错:`, signOrVerifyError);
                    console.error(`      Sighash (Hex): ${bufferToHex(sighashBytes)}`);
                    console.error(`      Private Key Used (Hex): ${bufferToHex(privateKeyToUse)}`);
                    console.error(`      Public Key for Verification (Hex): ${bufferToHex(pubkey)}`);
                    throw new Error(`无法使用 @noble/curves/secp256k1 为输入 #${i} 签名或验证`);
                }

                // 如果使用了 SIGHASH_DEFAULT 以外的类型，需要附加 sighash 类型字节
                const finalSignatureBuffer = sighashType === bitcoin.Transaction.SIGHASH_DEFAULT
                    ? bytesToBuffer(schnorrSignatureBytes) // 转换为 Buffer 供 PSBT 使用
                    : Buffer.concat([bytesToBuffer(schnorrSignatureBytes), Buffer.from([sighashType])]);

                console.log(`    输入 #${i} 最终签名 (Buffer): ${finalSignatureBuffer.toString('hex')}`);

                // 将签名添加到 PSBT 的 tapKeySig 字段 (需要 Buffer)
                 if (!psbt.data.inputs[i]) {
                      throw new Error(`尝试添加签名时找不到 PSBT 输入 #${i} 的数据`);
                 }
                 psbt.data.inputs[i].tapKeySig = finalSignatureBuffer;
                 console.log(`  - 输入 #${i} 的 tapKeySig 已手动设置。`);

                // 清除可能由先前失败的 signInput 调用留下的 partialSigs
                delete psbt.data.inputs[i].partialSig;
            }
        } catch (error) {
            console.error(`签名输入时出错: ${error.message}`);
            // ... (错误处理中不再需要计算 signerPubKey，因为验证已移入循环)
            try {
                console.error("PSBT Input Details:", JSON.stringify(psbt.data.inputs, null, 2));
            } catch (e) {
                console.error("无法序列化 PSBT 输入详情。");
            }
            return; // 在 finally 中关闭 rl
        }

        // 7. 完成交易
        console.log("完成交易...");
        let txHex;
        try {
            psbt.finalizeAllInputs();
            const tx = psbt.extractTransaction();
            txHex = tx.toHex();
            console.log(`\n最终交易 Hex: ${txHex}\n`);
            console.log("-------------------- 交易详情预览 --------------------");
            console.log(`  发送地址: ${fromAddress}`);
            console.log(`  接收地址数量: ${addresses.length}`);
            console.log(`  每个地址接收: ${amountToSendBTC} BTC (${amountInSats} sats)`);
            console.log(`  总发送额: ${Number(totalAmountToSend) / 1e8} BTC (${totalAmountToSend} sats)`);
            console.log(`  预计手续费: ${Number(finalFee) / 1e8} BTC (${finalFee} sats)`);
            if (changeValue >= 546) {
                console.log(`  预计找零: ${Number(changeValue) / 1e8} BTC (${changeValue} sats)`);
            } else {
                console.log(`  预计找零: 无 (小于粉尘阈值)`);
            }
            console.log("------------------------------------------------------");

        } catch (error) {
            console.error(`完成交易失败: ${error.message}`);
            return; // 在 finally 中关闭 rl
        }

        // 8. 确认广播
        const answer = await confirmBroadcast('确认要广播这笔交易吗? (输入 Y 确认): ');

        if (answer === 'Y') {
            console.log("\n广播交易...");
            try {
                const txId = await broadcastTx(txHex);
                console.log("-----------------------------------------");
                console.log(`交易成功广播!`);
                console.log(`交易 ID: ${txId}`);
                console.log(`发送地址: ${fromAddress}`);
                console.log(`接收地址数量: ${addresses.length}`);
                console.log(`每个地址接收金额: ${amountToSendBTC} BTC (${amountInSats} sats)`);
                console.log(`总发送金额: ${Number(totalAmountToSend) / 1e8} BTC (${totalAmountToSend} sats)`);
                console.log(`手续费: ${Number(finalFee) / 1e8} BTC (${finalFee} sats)`);
                if (changeValue >= 546) {
                    console.log(`找零金额: ${Number(changeValue) / 1e8} BTC (${changeValue} sats)`);
                }
                console.log("-----------------------------------------");
            } catch (error) {
                console.error(`\n广播交易时出错: ${error.message}`);
            }
        } else {
            console.log("\n用户取消广播。");
        }

    } catch (error) {
        console.error("批量发送过程中发生错误:", error);
    } finally {
        rl.close(); // 确保 readline 接口在使用后关闭
    }
}

// 运行批量发送
batchSend().catch(error => {
    console.error("发生未捕获的顶层错误:", error);
    if (typeof rl !== 'undefined' && rl) {
        rl.close();
    }
});