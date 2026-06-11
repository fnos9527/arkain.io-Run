const { chromium } = require('playwright');
const fs = require('fs');

// ─── 工具函数 ────────────────────────────────────────────────────────────────

async function sendTelegram(token, chatId, message, imagePath = null) {
  if (!token || !chatId) return;

  // 如果有截图，用 sendPhoto；否则用 sendMessage
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', message);
      form.append('parse_mode', 'HTML');
      form.append('photo', fs.createReadStream(imagePath));

      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
      });
      const data = await res.json();
      if (data.ok) { console.log('TG 带图通知发送成功'); return; }
    } catch (e) {
      console.log('带图发送失败，改用文字:', e.message);
    }
  }

  // 纯文字
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (!data.ok) console.error('TG 发送失败:', JSON.stringify(data));
  else console.log('TG 通知发送成功');
}

function parseCredits(text) {
  const match = text && text.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// 截图存到 /tmp/，便于调试
async function screenshot(page, name) {
  try {
    const p = `/tmp/arkain_${name}.png`;
    await page.screenshot({ path: p, fullPage: false });
    console.log(`截图已保存: ${p}`);
    return p;
  } catch {}
  return null;
}

// 通用：等待任意一个选择器出现（返回第一个匹配到的）
async function waitForAny(page, selectors, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        const visible = await el.isVisible().catch(() => false);
        if (visible) return sel;
      } catch {}
    }
    await page.waitForTimeout(500);
  }
  return null;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const email    = process.env.ARKAIN_EMAIL;
  const password = process.env.ARKAIN_PASSWORD;
  const tgToken  = process.env.TG_TOKEN;
  const tgChatId = process.env.TG_CHAT_ID;

  if (!email || !password) throw new Error('缺少 ARKAIN_EMAIL 或 ARKAIN_PASSWORD');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    // 禁用 webdriver 标记，防止反爬
    javaScriptEnabled: true,
  });

  // 隐藏 automation 特征
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  let creditsAfter = null;
  let screenshotPath = null;

  try {
    // ── 步骤 1：打开登录页，等待 SPA 渲染完成 ─────────────────────────────
    console.log('=== 步骤 1：打开登录页 ===');

    // 先访问首页让 cookie/session 初始化
    await page.goto('https://arkain.io/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 再跳转登录页
    await page.goto('https://arkain.io/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 等待 SPA JS 渲染（最多 30 秒），找任意 input
    console.log('等待登录表单渲染...');
    const foundEmailSel = await waitForAny(page, [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
      'input[id*="email" i]',
      'input[class*="email" i]',
      'input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"])',
    ], 30000);

    if (!foundEmailSel) {
      // 打印页面内容帮助调试
      const bodyText = await page.evaluate(() => document.body.innerHTML.substring(0, 3000));
      console.log('页面内容前 3000 字符:', bodyText);
      await screenshot(page, 'login_fail');
      throw new Error('找不到邮箱输入框，登录页结构未知');
    }

    console.log(`找到邮箱输入框: ${foundEmailSel}`);
    await screenshot(page, 'login_page');

    // ── 步骤 2：填写邮箱密码并提交 ────────────────────────────────────────
    console.log('=== 步骤 2：填写登录表单 ===');

    // 找所有 input，第一个非 hidden 的是邮箱，第二个是密码
    const inputs = page.locator('input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])');
    const count = await inputs.count();
    console.log(`页面上共找到 ${count} 个 input`);

    // 尝试定位邮箱框
    let emailInput = null;
    for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]', 'input[autocomplete="username"]', 'input[id*="email" i]']) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        emailInput = el;
        console.log(`邮箱 input 选择器: ${sel}`);
        break;
      }
    }
    // fallback：第 1 个 input
    if (!emailInput) emailInput = inputs.nth(0);

    await emailInput.click();
    await emailInput.fill('');
    await emailInput.type(email, { delay: 50 });
    console.log('邮箱已填写');

    // 密码框
    let passwordInput = page.locator('input[type="password"]').first();
    if (!(await passwordInput.isVisible().catch(() => false))) {
      passwordInput = inputs.nth(1);
    }
    await passwordInput.click();
    await passwordInput.fill('');
    await passwordInput.type(password, { delay: 50 });
    console.log('密码已填写');

    await screenshot(page, 'before_submit');

    // 点击登录按钮
    const loginBtnSelectors = [
      'button[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'button:has-text("Continue")',
      'input[type="submit"]',
    ];
    const foundBtnSel = await waitForAny(page, loginBtnSelectors, 10000);
    if (!foundBtnSel) throw new Error('找不到登录按钮');

    await page.locator(foundBtnSel).first().click();
    console.log(`已点击登录按钮 (${foundBtnSel})`);

    // ── 步骤 3：等待跳转到 dashboard ──────────────────────────────────────
    console.log('=== 步骤 3：等待进入 dashboard ===');
    try {
      await page.waitForURL(/dashboard/, { timeout: 30000 });
    } catch {
      // 有些站点不改 URL，等待登录成功的标志元素
      console.log('URL 未变化，等待 dashboard 页面元素...');
      await waitForAny(page, [
        'text=Daily check-in',
        'text=credits left',
        'text=D+1',
        '[class*="dashboard"]',
      ], 20000);
    }

    console.log('已进入 dashboard，当前 URL:', page.url());
    await page.waitForTimeout(2000);
    await screenshot(page, 'dashboard');

    // ── 步骤 4：读取签到前积分 ────────────────────────────────────────────
    console.log('=== 步骤 4：读取签到前积分 ===');
    let creditsBefore = null;
    try {
      // 积分显示格式："55 credits left" 或 "55 credits left Free"
      const creditsEl = page.locator('text=/\\d+\\s*credits\\s*left/i').first();
      await creditsEl.waitFor({ timeout: 8000 });
      creditsBefore = parseCredits(await creditsEl.textContent());
      console.log('签到前积分:', creditsBefore);
    } catch {
      console.log('未能读取签到前积分');
    }

    // ── 步骤 5：点击 D+1 签到入口（标记①） ───────────────────────────────
    console.log('=== 步骤 5：点击 D+1 入口按钮 ===');
    const d1Selectors = [
      'button:has-text("D+1")',
      '[class*="checkin"]:visible',
      '[class*="check-in"]:visible',
      'text=D+1',
      // 顶部区域的按钮（右上角）
      'header button',
      'nav button',
    ];
    const foundD1 = await waitForAny(page, d1Selectors, 15000);
    if (!foundD1) {
      await screenshot(page, 'd1_not_found');
      throw new Error('找不到 D+1 签到按钮');
    }
    await page.locator(foundD1).first().click();
    console.log(`已点击 D+1 按钮 (${foundD1})`);
    await page.waitForTimeout(1500);
    await screenshot(page, 'checkin_modal');

    // ── 步骤 6：点击弹窗内签到按钮（标记②） ─────────────────────────────
    console.log('=== 步骤 6：点击签到弹窗按钮 ===');
    const modalBtnSelectors = [
      'button:has-text("Daily check-in and receive credit")',
      'button:has-text("Daily check-in")',
      'button:has-text("Check in")',
      'button:has-text("check-in")',
      // 弹窗/对话框内的主按钮
      '[role="dialog"] button:not([aria-label*="close" i])',
      '[role="dialog"] button',
      '.modal button',
    ];
    const foundModalBtn = await waitForAny(page, modalBtnSelectors, 15000);
    if (!foundModalBtn) {
      await screenshot(page, 'modal_btn_not_found');
      throw new Error('找不到签到弹窗按钮');
    }
    await page.locator(foundModalBtn).first().click();
    console.log(`已点击签到按钮 (${foundModalBtn})`);
    await page.waitForTimeout(2000);

    // ── 步骤 7：刷新页面，读取签到后积分（标记③） ───────────────────────
    console.log('=== 步骤 7：刷新页面，读取签到后积分 ===');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    try {
      const creditsEl = page.locator('text=/\\d+\\s*credits\\s*left/i').first();
      await creditsEl.waitFor({ timeout: 10000 });
      creditsAfter = parseCredits(await creditsEl.textContent());
      console.log('签到后积分:', creditsAfter);
    } catch {
      console.log('未能读取签到后积分');
    }

    screenshotPath = await screenshot(page, 'final');

    // ── 步骤 8：发送 TG 通知 ──────────────────────────────────────────────
    console.log('=== 步骤 8：发送 TG 通知 ===');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    let message = '';

    if (creditsAfter !== null && creditsBefore !== null) {
      const gained = creditsAfter - creditsBefore;
      message = `✅ <b>Arkain 每日签到成功</b>\n\n` +
        `📅 时间：${now}\n` +
        `💰 签到前：${creditsBefore} credits\n` +
        `💰 签到后：${creditsAfter} credits\n` +
        `🎁 本次获得：<b>+${gained > 0 ? gained : '?'}</b> credits`;
    } else if (creditsAfter !== null) {
      message = `✅ <b>Arkain 每日签到成功</b>\n\n` +
        `📅 时间：${now}\n` +
        `💰 当前积分：${creditsAfter} credits`;
    } else {
      message = `✅ <b>Arkain 签到已执行</b>\n\n` +
        `📅 时间：${now}\n` +
        `⚠️ 积分数值读取失败，请手动确认`;
    }

    console.log('通知内容:\n' + message.replace(/<[^>]+>/g, ''));
    await sendTelegram(tgToken, tgChatId, message, screenshotPath);

  } catch (err) {
    console.error('签到流程出错:', err.message);
    screenshotPath = await screenshot(page, 'error');
    if (tgToken && tgChatId) {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      await sendTelegram(tgToken, tgChatId,
        `❌ <b>Arkain 签到失败</b>\n\n📅 时间：${now}\n🔴 错误：${err.message}`,
        screenshotPath
      );
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
