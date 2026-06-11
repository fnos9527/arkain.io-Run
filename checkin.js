const { chromium } = require('playwright');

// ─── 工具函数 ────────────────────────────────────────────────────────────────

async function sendTelegram(token, chatId, message) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const data = await res.json();
  if (!data.ok) {
    console.error('TG 发送失败:', JSON.stringify(data));
  } else {
    console.log('TG 通知发送成功');
  }
}

// 从 "55 credits left" 这类字符串中提取数字
function parseCredits(text) {
  const match = text && text.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// 等待并点击，带重试
async function waitAndClick(page, selector, description, timeout = 15000) {
  console.log(`等待元素: ${description} (${selector})`);
  await page.waitForSelector(selector, { state: 'visible', timeout });
  await page.click(selector);
  console.log(`已点击: ${description}`);
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const email = process.env.ARKAIN_EMAIL;
  const password = process.env.ARKAIN_PASSWORD;
  const tgToken = process.env.TG_TOKEN;
  const tgChatId = process.env.TG_CHAT_ID;

  if (!email || !password) {
    throw new Error('缺少环境变量 ARKAIN_EMAIL 或 ARKAIN_PASSWORD');
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  let creditsAfter = null;

  try {
    // ── 步骤 1：登录 ──────────────────────────────────────────────────────────
    console.log('=== 步骤 1：打开登录页 ===');
    await page.goto('https://arkain.io/login', { waitUntil: 'networkidle', timeout: 30000 });

    // 等待邮箱输入框出现
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i], input[placeholder*="Email" i]', {
      timeout: 15000,
    });

    // 填写邮箱
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    await emailInput.fill(email);
    console.log('已填写邮箱');

    // 填写密码
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.fill(password);
    console.log('已填写密码');

    // 点击登录按钮
    // 尝试多种选择器
    const loginBtn = page.locator(
      'button[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")'
    ).first();
    await loginBtn.click();
    console.log('已点击登录按钮');

    // 等待跳转到 dashboard
    await page.waitForURL(/dashboard/, { timeout: 30000 });
    console.log('登录成功，已进入 dashboard');

    // 等待页面稳定
    await page.waitForLoadState('networkidle', { timeout: 20000 });

    // ── 步骤 2：读取签到前积分 ──────────────────────────────────────────────
    console.log('=== 步骤 2：读取签到前积分 ===');
    // credits 显示在顶部，格式为 "55 credits left"
    let creditsBefore = null;
    try {
      const creditsEl = page.locator('text=/\\d+ credits left/i').first();
      await creditsEl.waitFor({ timeout: 10000 });
      const creditsText = await creditsEl.textContent();
      creditsBefore = parseCredits(creditsText);
      console.log(`签到前积分: ${creditsBefore}`);
    } catch {
      console.log('未能读取签到前积分（将在签到后读取）');
    }

    // ── 步骤 3：点击 D+1 签到入口按钮（标记①） ────────────────────────────
    console.log('=== 步骤 3：点击 D+1 签到入口 ===');
    // D+1 按钮在右上角，尝试多种选择器
    const checkinEntryBtn = page.locator(
      'button:has-text("D+1"), [aria-label*="check" i], button[class*="checkin" i], button[class*="check-in" i]'
    ).first();

    // 如果上面找不到，再用图片中的位置特征：包含 "D+1" 文字的按钮
    try {
      await checkinEntryBtn.waitFor({ state: 'visible', timeout: 10000 });
      await checkinEntryBtn.click();
    } catch {
      // fallback：找页面上所有含 D+1 文字的元素
      console.log('尝试备用选择器查找 D+1 按钮...');
      const fallback = page.locator('text=D+1').first();
      await fallback.waitFor({ state: 'visible', timeout: 10000 });
      await fallback.click();
    }
    console.log('已点击 D+1 按钮，等待弹窗出现...');

    // 等待弹窗出现
    await page.waitForTimeout(1500);

    // ── 步骤 4：点击弹窗内 "Daily check-in and receive credit" 按钮（标记②） ─
    console.log('=== 步骤 4：点击签到按钮 ===');
    const checkinBtn = page.locator(
      'button:has-text("Daily check-in and receive credit"), button:has-text("Daily check-in")'
    ).first();
    await checkinBtn.waitFor({ state: 'visible', timeout: 15000 });
    await checkinBtn.click();
    console.log('已点击签到按钮');

    // 等待签到请求完成
    await page.waitForTimeout(2000);

    // ── 步骤 5：刷新页面，读取签到后积分（标记③） ─────────────────────────
    console.log('=== 步骤 5：刷新页面，读取签到后积分 ===');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });

    try {
      const creditsEl = page.locator('text=/\\d+ credits left/i').first();
      await creditsEl.waitFor({ timeout: 10000 });
      const creditsText = await creditsEl.textContent();
      creditsAfter = parseCredits(creditsText);
      console.log(`签到后积分: ${creditsAfter}`);
    } catch {
      console.log('未能读取签到后积分');
    }

    // ── 步骤 6：计算差值，发送 TG 通知 ─────────────────────────────────────
    console.log('=== 步骤 6：发送 TG 通知 ===');
    let message = '';
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

    if (creditsAfter !== null && creditsBefore !== null) {
      const gained = creditsAfter - creditsBefore;
      message =
        `✅ <b>Arkain 每日签到成功</b>\n\n` +
        `📅 时间：${now}\n` +
        `💰 签到前积分：${creditsBefore}\n` +
        `💰 签到后积分：${creditsAfter}\n` +
        `🎁 本次获得：<b>+${gained}</b> credits`;
    } else if (creditsAfter !== null) {
      message =
        `✅ <b>Arkain 每日签到成功</b>\n\n` +
        `📅 时间：${now}\n` +
        `💰 当前积分：${creditsAfter} credits`;
    } else {
      message =
        `✅ <b>Arkain 每日签到已执行</b>\n\n` +
        `📅 时间：${now}\n` +
        `⚠️ 积分读取失败，请手动确认`;
    }

    console.log('通知内容:\n' + message.replace(/<[^>]+>/g, ''));

    if (tgToken && tgChatId) {
      await sendTelegram(tgToken, tgChatId, message);
    } else {
      console.log('未配置 TG_TOKEN / TG_CHAT_ID，跳过 Telegram 通知');
    }
  } catch (err) {
    console.error('签到流程出错:', err.message);

    // 出错也尝试发 TG 通知
    if (tgToken && tgChatId) {
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
      await sendTelegram(
        tgToken,
        tgChatId,
        `❌ <b>Arkain 签到失败</b>\n\n📅 时间：${now}\n🔴 错误：${err.message}`
      );
    }

    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
