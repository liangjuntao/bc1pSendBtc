# Bitcoin 批量转账工具 (P2WPKH)

这是一个 Node.js 脚本，用于从单个比特币原生隔离见证地址 (P2WPKH, 以 `bc1q` 开头) 向多个接收地址批量发送相同数量的比特币。

## 功能

*   从 WIF 格式的私钥恢复 P2WPKH 地址。
*   从 `addresses.txt` 文件读取接收地址列表。
*   从 `config.json` 文件读取配置，包括发送金额和可选的固定费率。
*   自动从 Mempool.space API 获取 UTXO (未花费交易输出)。
*   自动获取推荐费率 (如果未在 `config.json` 中指定)。
*   使用 P2WPKH 格式构建和签名比特币交易 (PSBT)。
*   自动计算交易费用，并进行余额检查。
*   将找零发送回原始 P2WPKH 地址。
*   通过 Mempool.space API 广播交易。
*   提供详细的日志输出。

## 文件结构

```
bc1pSendBtc/
├── main.js           # 主程序脚本
├── config.json       # 配置文件 (私钥、发送金额、费率)
├── addresses.txt     # 接收地址列表 (每行一个)
├── package.json      # 项目依赖
├── package-lock.json # 依赖锁定文件
└── node_modules/     # Node.js 依赖目录
```

## 配置 (`config.json`)

在运行脚本之前，请创建并配置 `config.json` 文件：

```json
{
  "privateKey": "在此处输入您的WIF格式私钥",
  "sendAmountBTC": 0.0001,
  "feeRate": 5 
}
```

*   `privateKey`: **必需**。您的钱包的 WIF (Wallet Import Format) 格式私钥。脚本将从此私钥派生出 P2WPKH 发送地址。
*   `sendAmountBTC`: **必需**。要发送给 `addresses.txt` 中每个地址的比特币数量 (以 BTC 为单位)。
*   `feeRate`: **可选**。固定的交易费率 (单位：sat/vB)。如果提供此字段且为有效数字，脚本将使用此固定费率。如果省略或无效，脚本将自动从 Mempool.space API 获取推荐的最高优先级费率。

**重要提示：** 请妥善保管您的私钥！不要将包含私钥的 `config.json` 文件分享给任何人或上传到公共代码库。

## 接收地址 (`addresses.txt`)

创建一个名为 `addresses.txt` 的文本文件，并将所有接收方的比特币地址放入其中，**每个地址占一行**：

```
bc1q...
bc1q...
3...
1...
```

脚本支持向各种类型的比特币地址发送。

## 安装依赖

在项目根目录下运行以下命令安装所需的 Node.js 模块：

```bash
npm install
```

这将安装 `bitcoinjs-lib`, `axios`, `ecpair`, `tiny-secp256k1` 等依赖。

## 使用方法

配置好 `config.json` 和 `addresses.txt` 文件，并安装完依赖后，在项目根目录下运行脚本：

```bash
node main.js
```

脚本将执行以下步骤：

1.  读取配置和地址。
2.  生成发送地址。
3.  获取 UTXO 和费率。
4.  构建 PSBT 交易。
5.  计算费用并检查余额。
6.  签名交易。
7.  广播交易。
8.  输出交易 ID 或错误信息。

请仔细检查脚本输出的日志信息，特别是费用估算和余额检查部分。

## 注意事项

*   **私钥安全**：再次强调，请务必保护好您的私钥。
*   **余额**：确保您的发送地址有足够的 BTC 来支付所有转账金额以及网络手续费。
*   **粉尘**：脚本会自动检查找零金额是否低于粉尘阈值 (546 satoshis)，如果低于此值，将不会创建找零输出，这部分金额会作为额外的手续费。
*   **API 依赖**：脚本依赖 Mempool.space API 来获取 UTXO、费率和广播交易。如果 API 不可用或网络连接有问题，脚本可能会失败。
*   **测试网**：当前脚本硬编码使用比特币主网 (`bitcoin.networks.bitcoin`)。如果需要在测试网上使用，需要修改 `main.js` 中的网络设置。 