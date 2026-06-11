const { chromium } = require('playwright');

// ─── 工具函数 ────────────────────────────────────────────────────────────────

async function sendTelegram(token, chatId, message) {
  if (!token || !chatId) { console.log('未配置 TG，跳过通知'); return; }
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
  } catch (e) { console.log('截图失败:', e.message); }
}

// 关闭页面上所有可能出现的弹窗（cookie + 功能介绍）
async function dismissPopups(page) {
  console.log('检查并关闭弹窗...');

  // 1. Cookie 弹窗："Accept all" 或 "Confirm my choices"
  const cookieSelectors = [
    'button:has-text("Accept all")',
    'button:has-text("Confirm my choices")',
    'button:has-text("Accept")',
  ];
  for (const sel of cookieSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click();
        console.log(`已关闭 cookie 弹窗 (${sel})`);
        await page.waitForTimeout(800);
        break;
      }
    } catch {}
  }

  // 2. 功能介绍弹窗（"Plan Mode" 那个）：点 X 关闭
  //    关闭按钮通常是 aria-label="Close" 或 role="dialog" 内的 × 按钮
  const closeSelectors = [
    '[role="dialog"] button[aria-label="Close"]',
    '[role="dialog"] button[aria-label="close"]',
    '[role="dialog"] button:has-text("×")',
    '[role="dialog"] button:has-text("✕")',
    // 截图里右上角的 × 按钮
    'button.close',
    '[aria-label="Close"]',
    '[aria-label="close"]',
  ];
  for (const sel of closeSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click();
        console.log(`已关闭功能介绍弹窗 (${sel})`);
        await page.waitForTimeout(800);
        break;
      }
    } catch {}
  }

  // 3. 如果还有对话框（比如多步骤的 Next 按钮），按 Escape 关掉
  try {
    const dialog = page.locator('[role="dialog"]').first();
    if (await dialog.isVisible({ timeout: 2000 })) {
      await page.keyboard.press('Escape');
      console.log('已按 Escape 关闭残余弹窗');
      await page.waitForTimeout(800);
    }
  } catch {}
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
    // ── 步骤 1：打开登录页 ────────────────────────────────────────────────
    console.log('=== 步骤 1：打开登录页 ===');
    await page.goto('https://account.arkain.io/login', {
      waitUntil: 'domcontentloaded',   // 不等 networkidle，SPA 用 domcontentloaded
      timeout: 30000,
    });
    await page.waitForSelector('input[placeholder="Your E-mail"]', {
      state: 'visible',
      timeout: 20000,
    });
    console.log('登录页已加载');

    // 关掉登录页可能出现的 cookie 弹窗
    await dismissPopups(page);
    await screenshot(page, 'login_page');

    // ── 步骤 2：填写表单 ──────────────────────────────────────────────────
    console.log('=== 步骤 2：填写邮箱密码 ===');
    // 从截图确认 placeholder 是 "Your E-mail" 和 "Your Password"
    await page.locator('input[placeholder="Your E-mail"]').fill(email);
    console.log('邮箱已填写');
    await page.locator('input[type="password"]').fill(password);
    console.log('密码已填写');
    await screenshot(page, 'before_login');

    // ── 步骤 3：点击 Login ────────────────────────────────────────────────
    console.log('=== 步骤 3：点击 Login 按钮 ===');
    await page.locator('button:has-text("Login")').click();
    console.log('已点击 Login');

    // ── 步骤 4：等待跳转到 dashboard ─────────────────────────────────────
    // 日志显示跳转路径：account → auth/callback → ap-south-1.arkain.io/dashboard
    // 用 waitForURL 只等 domcontentloaded，不等 networkidle
    console.log('=== 步骤 4：等待跳转 dashboard ===');
    await page.waitForURL('**/dashboard**', {
      waitUntil: 'domcontentloaded',
      timeout: 40000,
    });
    console.log('已进入 dashboard:', page.url());

    // 等待页面主体渲染（不用 networkidle，避免超时）
    await page.waitForTimeout(3000);
    await screenshot(page, 'dashboard_raw');

    // ── 步骤 5：关闭 dashboard 上的弹窗 ──────────────────────────────────
    console.log('=== 步骤 5：关闭 dashboard 弹窗 ===');
    await dismissPopups(page);
    await screenshot(page, 'dashboard_clean');

    // ── 步骤 6：读取签到前积分 ────────────────────────────────────────────
    console.log('=== 步骤 6：读取签到前积分 ===');
    let creditsBefore = null;
    try {
      const creditsEl = page.locator('text=/\\d+\\s*credits\\s*left/i').first();
      await creditsEl.waitFor({ state: 'visible', timeout: 10000 });
      creditsBefore = parseCredits(await creditsEl.textContent());
      console.log('签到前积分:', creditsBefore);
    } catch {
      console.log('未能读取签到前积分');
    }

    // ── 步骤 7：点击 D+1 签到入口（右上角，标记①） ───────────────────────
    console.log('=== 步骤 7：点击 D+1 入口 ===');
    let d1Btn = null;
    const d1Candidates = [
      'button:has-text("D+1")',
      'text=D+1',
      '[class*="daily"]',
      '[class*="checkin"]',
      '[class*="check-in"]',
    ];
    for (const sel of d1Candidates) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 4000 })) {
          d1Btn = el;
          console.log(`D+1 选择器: ${sel}`);
          break;
        }
      } catch {}
    }
    if (!d1Btn) {
      await screenshot(page, 'd1_not_found');
      throw new Error('找不到 D+1 签到入口按钮');
    }
    await d1Btn.click();
    console.log('已点击 D+1');
    await page.waitForTimeout(1500);
    await screenshot(page, 'checkin_modal');

    // ── 步骤 8：点击"Daily check-in and receive credit"（标记②） ─────────
    console.log('=== 步骤 8：点击签到按钮 ===');
    let modalBtn = null;
    const modalCandidates = [
      'button:has-text("Daily check-in and receive credit")',
      'button:has-text("Daily check-in")',
      'button:has-text("Check in")',
      'button:has-text("Receive")',
    ];
    for (const sel of modalCandidates) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 5000 })) {
          modalBtn = el;
          console.log(`签到按钮选择器: ${sel}`);
          break;
        }
      } catch {}
    }
    if (!modalBtn) {
      await screenshot(page, 'modal_not_found');
      throw new Error('找不到签到弹窗按钮');
    }
    await modalBtn.click();
    console.log('已点击签到按钮');
    await page.waitForTimeout(2000);

    // ── 步骤 9：刷新页面，读取签到后积分（标记③） ───────────────────────
    console.log('=== 步骤 9：刷新页面读取积分 ===');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    // 刷新后可能再次出现弹窗，再关一次
    await dismissPopups(page);

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

    // ── 步骤 10：发送 TG 通知 ─────────────────────────────────────────────
    console.log('=== 步骤 10：发送 TG 通知 ===');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    let message = '';

    if (creditsAfter !== null && creditsBefore !== null) {
      const gained = creditsAfter - creditsBefore;
      message =
        `✅ <b>Arkain 每日签到成功</b>\n\n` +
        `📅 时间：${now}\n` +
        `💰 签到前：${creditsBefore} credits\n` +
        `💰 签到后：${creditsAfter} credits\n` +
        `🎁 本次获得：<b>+${gained > 0 ? gained : '0（可能今日已签）'}</b>`;
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

    console.log('通知:\n' + message.replace(/<[^>]+>/g, ''));
    await sendTelegram(tgToken, tgChatId, message);

  } catch (err) {
    console.error('签到出错:', err.message);
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
