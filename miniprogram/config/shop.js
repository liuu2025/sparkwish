// 中枢购买服务的集中配置。
// 这里只保存前端可以公开持有的信息，不存放令牌、私密查询号、卡密或任何密钥。
// 地址或项目标识被清空时，页面回到“未配置”状态并且不发起请求。
module.exports = {
  // 中枢购买服务地址，必须为 HTTPS（结尾斜杠会被忽略）
  baseURL: 'https://buy.douyinspark.top',

  // 商品所属项目标识（云端目录只返回该项目已上架的套餐）
  projectID: 'sparkpilot',

  // 套餐展示顺序；留空表示沿用目录返回顺序
  planIDs: [
    'plan_3739e34ffe6fb436afa784e0caf378bd',
    'plan_9ee5cbde0918979c9da1fc172793f575',
  ],

  // 本渠道固定使用小程序虚拟支付，下单时必须声明
  paymentMethod: 'virtual',

  // 订单查询接口是否接入；关闭时“我的订单”显示“订单服务暂未接入”
  ordersEnabled: true,

  // 真实支付是否开放；打开后“选择此套餐”会真实扣款
  paymentEnabled: true,

  // 请求超时（毫秒）
  timeout: 15000,
};
