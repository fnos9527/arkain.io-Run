const { chromium } = require('playwright');
const fs = require('fs');

// ─── 工具函数 ────────────────────────────────────────────────────────────────

async function sendTelegram(token, chatId, message) {
  if (!token || !chatId) {
    console.log('未配置 TG，跳过通知');
    return;
  }
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

async function screenshot(page, name) {
  try {
    const p = `/tmp/arkain_${name}.png`;
    await page.screenshot({ path: p, fullPage: false });
    console.log(`截图: ${p}`);
    return p;
  } catch (e) {
    console.log('截图失败:', e.message);
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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    // ── 步骤 1：打开正确的登录页 account.arkain.io/login ─────────────────
    console.log('=== 步骤 1：打开登录页 account.arkain.io/login ===');
    await page.goto('https://account.arkain.io/login', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // 等待 Email 输入框出现（从截图看 label 是 "Email"，input 无 type 或 type=text）
    await page.waitForSelector('input', { state: 'visible', timeout: 20000 });
    console.log('登录页已加载');
    await screenshot(page, 'login_page');

    // ── 步骤 2：填写邮箱 ──────────────────────────────────────────────────
    console.log('=== 步骤 2：填写邮箱密码 ===');

    // 从截图看：Email 框在上，Password 框在下，直接取第1/第2个 input
    const allInputs = page.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="submit"])');
    const inputCount = await allInputs.count();
    console.log(`共找到 ${inputCount} 个 input`);

    // 邮箱：优先用 type=email 或 label 匹配，fallback 第1个
    let emailInput = page.locator('input[type="email"]').first();
    if (!(await emailInput.isVisible().catch(() => false))) {
      emailInput = allInputs.nth(0);
    }
    await emailInput.click();
    await emailInput.fill(email);
    console.log('邮箱已填写');

    // 密码
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.click();
    await passwordInput.fill(password);
    console.log('密码已填写');

    await screenshot(page, 'before_login');

    // ── 步骤 3：点击 Login 按钮 ──────────────────────────────────────────
    console.log('=== 步骤 3：点击 Login 按钮 ===');
    // 从截图看按钮文字是 "Login"
    const loginBtn = page.locator('button:has-text("Login"), button[type="submit"]').first();
    await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
    await loginBtn.click();
    console.log('已点击 Login 按钮');

    // ── 步骤 4：等待跳转到 dashboard ─────────────────────────────────────
    console.log('=== 步骤 4：等待跳转 dashboard ===');
    // 登录后跳转到 ap-south-1.arkain.io/dashboard
    await page.waitForURL(/dashboard/, { timeout: 30000 });
    console.log('已进入 dashboard:', page.url());

    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(2000);
    await screenshot(page, 'dashboard');

    // ── 步骤 5：读取签到前积分 ────────────────────────────────────────────
    console.log('=== 步骤 5：读取签到前积分 ===');
    let creditsBefore = null;
    try {
      // 顶部显示 "55 credits left Free" 这样的文字
      const creditsEl = page.locator('text=/\\d+\\s*credits\\s*left/i').first();
      await creditsEl.waitFor({ state: 'visible', timeout: 10000 });
      creditsBefore = parseCredits(await creditsEl.textContent());
      console.log('签到前积分:', creditsBefore);
    } catch {
      console.log('未能读取签到前积分');
    }

    // ── 步骤 6：点击 D+1 签到入口按钮（右上角，标记①） ─────────────────
    console.log('=== 步骤 6：点击 D+1 签到入口 ===');

    // 从截图看 D+1 按钮在右上角，包含文字 "D+1"
    let d1Btn = null;
    const d1Candidates = [
      'button:has-text("D+1")',
      '[class*="daily"]:visible',
      '[class*="checkin"]:visible',
      '[class*="check-in"]:visible',
      'text=D+1',
    ];
    for (const sel of d1Candidates) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        d1Btn = el;
        console.log(`D+1 按钮选择器: ${sel}`);
        break;
      }
    }

    if (!d1Btn) {
      await screenshot(page, 'd1_not_found');
      throw new Error('找不到 D+1 签到入口按钮');
    }

    await d1Btn.click();
    console.log('已点击 D+1 按钮');

    // 等待弹窗动画
    await page.waitForTimeout(1500);
    await screenshot(page, 'checkin_modal');

    // ── 步骤 7：点击弹窗内"Daily check-in and receive credit"按钮（标记②）
    console.log('=== 步骤 7：点击弹窗签到按钮 ===');

    // 从第一张截图看弹窗按钮文字是 "Daily check-in and receive credit"
    const modalBtnCandidates = [
      'button:has-text("Daily check-in and receive credit")',
      'button:has-text("Daily check-in")',
      'button:has-text("Check in")',
      'button:has-text("Receive")',
    ];
    let modalBtn = null;
    for (const sel of modalBtnCandidates) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        modalBtn = el;
        console.log(`签到按钮选择器: ${sel}`);
        break;
      }
    }

    if (!modalBtn) {
      await screenshot(page, 'modal_not_found');
      throw new Error('找不到签到弹窗按钮');
    }

    await modalBtn.click();
    console.log('已点击签到按钮');
    await page.waitForTimeout(2000);

    // ── 步骤 8：刷新页面，读取签到后积分（标记③） ───────────────────────
    console.log('=== 步骤 8：刷新页面读取积分 ===');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    let creditsAfter = null;
    try {
      const creditsEl = page.locator('text=/\\d+\\s*credits\\s*left/i').first();
      await creditsEl.waitFor({ state: 'visible', timeout: 10000 });
      creditsAfter = parseCredits(await creditsEl.textContent());
      console.log('签到后积分:', creditsAfter);
    } catch {
      console.log('未能读取签到后积分');
    }

    await screenshot(page, 'final');

    // ── 步骤 9：发送 TG 通知 ─────────────────────────────────────────────
    console.log('=== 步骤 9：发送 TG 通知 ===');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    let message = '';

    if (creditsAfter !== null && creditsBefore !== null) {
      const gained = creditsAfter - creditsBefore;
      message =
        `✅ <b>Arkain 每日签到成功</b>\n\n` +
        `📅 时间：${now}\n` +
        `💰 签到前：${creditsBefore} credits\n` +
        `💰 签到后：${creditsAfter} credits\n` +
        `🎁 本次获得：<b>+${gained > 0 ? gained : '(今日已签或数值异常)'}</b>`;
    } else if (creditsAfter !== null) {
      message =
        `✅ <b>Arkain 每日签到成功</b>\n\n` +
        `📅 时间：${now}\n` +
        `💰 当前积分：${creditsAfter} credits`;
    } else {
      message =
        `✅ <b>Arkain 签到流程已完成</b>\n\n` +
        `📅 时间：${now}\n` +
        `⚠️ 积分读取失败，请手动确认`;
    }

    console.log('=== 通知内容 ===\n' + message.replace(/<[^>]+>/g, ''));
    await sendTelegram(tgToken, tgChatId, message);

  } catch (err) {
    console.error('签到流程出错:', err.message);
    await screenshot(page, 'error');

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    await sendTelegram(tgToken, tgChatId,
      `❌ <b>Arkain 签到失败</b>\n\n📅 时间：${now}\n🔴 错误：${err.message}`
    );
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
