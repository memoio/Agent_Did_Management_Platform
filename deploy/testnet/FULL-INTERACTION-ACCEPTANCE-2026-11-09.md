# opBNB 完整交互隔离验收（2026-11-09）

网络 `eip155:5611`；沿用部署清单 `opbnb-agentdid-20261109-a` 的两份合约，未重新部署。Manager 使用仅供本次验收的隔离钱包 `0x36927b3Ee2D944B89ed134E5367E29B723F3E212`。下表只含公开链上证据；密钥、会话 Token、Invitation/Offer 一次性 handle 及签名原文均未写入仓库。

| 旅程与动作 | DID | operationId | txHash | blockNumber | blockHash |
| --- | --- | --- | --- | ---: | --- |
| Offer：注册 | `did:memo:agent:5611:0x4b9fe995622a192fdb4287a7dce1286e6c8dd35e` | `832ed4c4-4fc5-4a63-868d-07aa4a167393` | `0x950c69b16122f3e46ae45fb15ca94717d84848381e512b8adf96ed4e680fae33` | 221605791 | `0x04b0e8ad87172da75dbeea2f489ca1fcb02ee26e7ac4d07a5af24ba9bf854a39` |
| Offer：双签建立关系 | 同上 | `6bf0da74-dfd1-44d9-9767-4c3fa6402d94` | `0x4015309c2512afbc0ca83ec4d3cc3c9dba16004887dc8512da2d74d0260ca08a` | 221609879 | `0x35b6d4528164b1bd764ddc8f4ccba44546649847bc2495c0828348534873f00e` |
| Invitation：注册 | `did:memo:agent:5611:0xd15d3ae0f9375f3686d70f33448a8b383b0fb0e6` | `1da494c4-4aee-45e2-909d-1800970a6157` | `0x31e9e506a12e695a07dda3f8ec31ea4269c076549f3f7609a9bdcc994a6d4bec` | 221610844 | `0x24c9777323909a75707ba65ea9fa228ec0b048553f29c46a0055cef18ff5a3f2` |
| Invitation：双签建立关系 | 同上 | `9d5af47d-07e2-4ca2-90fa-d85ef115f05d` | `0x3c1eda6f028c22badd2ce9ebca3fe13d71e2f46208fb1536a7501958ef8e578d` | 221611603 | `0xe51e104f5622ebc7ca0e1d137645984dbf234a145edcc09d217dac344a10e1ba` |
| Profile 更新 | 第一个 DID | `f5370732-3c9d-4df1-8f39-1e1c35b77852` | `0x9a9b389cc1d9f1e20724c7ecd18862b7d34bde5e089fcbbe012ea3e327eada7a` | 221612133 | `0x31e63c3914d022865a0ec2318a2a1f74abdebd57d00a399cf11fe121dd0701fa` |
| 身份暂停 | 第一个 DID | `b6688095-ac0c-4c7c-be73-cb674cc879e8` | `0x05bf5ff2842f647c86101a4d6f1d6c12f923edf9ab48412d24927256c665eaac` | 221612788 | `0x641ba6791ada2abb1333fa8a9e5365859a83c31817fb6ed7d1127af3dad0c463` |
| 身份恢复 | 第一个 DID | `4466e6ca-7456-4e21-9264-ceff94cd60d2` | `0x205dc98aeadeb1575edd652ffd383bf9da4b6f09a834017aaeb64c402bc995f7` | 221613280 | `0x3fbac4061781e8cd2919d66673d0701c2e3c4bf4acc963cffb9052e5c3988457` |
| 实例凭证撤销 | 第一个 DID | `0a318c84-84f4-4ffe-8518-7bacbdda523c` | `0xca5332c7814783f3034b483673fefee2403f49621ee0d701e535fb2473227764` | 221614164 | `0x8657769ae55d610ed7c0adfe5c25e5745046e22cc95aacb2a77d5787fc1a64c4` |

以上八个 operation 的最终数据库状态均为 `CONFIRMED`，`finalitySource=finalized-tag`。两条管理关系经双 RPC 读取均为 `live=true`，Manager 均为上文隔离钱包。两个 DID 均为 `ACTIVE`，解析结果 `verified=true`；第一个 DID 的 Profile 已更新为 `opBNB Test Agent updated`，身份 revision 为 5。实例 `inst_0e81fbe2-9e04-4d89-a6f5-d21e005a047f` 在确认后显示 `REVOKED`，再次控制证明返回 `INSTANCE_NOT_FOUND`。API 重启后隔离 Manager 的 Dashboard 仍显示 2 个管理中 Agent、审计中有 2 条 `PAIRING_COMPLETED`；原有历史 DID 也仍可解析。

Worker 停机期间测试链继续前进，原 100 区块索引窗口导致事件投影明显落后。本轮将每次扫描上限提高至 2000 区块；适配器仍按小块向双 RPC 读取日志，读取失败不推进游标。重启单 Worker 后，游标追过本次交易区块：第一个 DID 的 6 条事件和第二个 DID 的 2 条事件均入库。数据库联查确认 **8 个已确认 operation 的 txHash 与 blockHash 都匹配各自链事件，重复事件键为 0**。

Offer 第一次管理签名意图在链读取暂时不可用期间过期，平台没有为其发交易。草稿刷新后双方对新 digest `0x62285afde31cca7e2f575d6011d1950f551b01667f07fe72e6c7fc6b28da8e27` 重新签名，才提交表中确认交易。这验证了过期签名不会被静默复用。Invitation 管理 digest 为 `0xd7c34e48ea67780ba66c6ab404133bed101634f70e98a0f6f48e765775f7c394`。

离线验证使用独立 PostgreSQL，`npm run build` 和 `npm test` 均通过（8 个测试文件、26 个测试）。现有历史 DID 及管理关系只做兼容性查询，未被更新、吊销或转移。浏览器钱包在早期直接管理路径曾完成真实签名；本次两种配对旅程的 Manager 签名由隔离测试钱包脚本执行，Console 的新配对页面只做了界面检查，尚未做浏览器扩展端到端自动化。
