const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function run() {
  console.log('🚀 Running final verification tests...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  // Rubric and Storage & Sync tabs are hidden in the default public view, so
  // open the organizer view. BASE_URL lets it target any local port.
  await page.goto((process.env.BASE_URL || 'http://127.0.0.1:8888') + '/?role=admin', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 600));

  // Test 8: Click first card to view details modal
  console.log('🔍 Capturing Team Details Modal on Mobile...');
  await page.evaluate(() => {
    const card = document.querySelector('#mobile-cards-container > div');
    if (card) card.click();
  });
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10_mobile_team_details_modal.png') });

  // Close modal
  await page.evaluate(() => {
    const modal = document.getElementById('details-modal');
    if (modal) modal.classList.add('hidden');
  });
  await new Promise(r => setTimeout(r, 300));

  // Test 9: Mobile Rubric View
  console.log('📖 Capturing Mobile Rubric View...');
  await page.click('#mob-nav-rubric');
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '11_mobile_rubric_view.png') });

  // Scroll down rubric to see cards
  await page.evaluate(() => window.scrollBy(0, 400));
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '11b_mobile_rubric_cards.png') });

  // Test 10: Mobile Storage & Sync View
  console.log('☁️ Capturing Mobile Storage & Sync View...');
  await page.click('#mob-nav-sync');
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '12_mobile_storage_sync_view.png') });

  console.log('✅ Final screenshots captured!');
  await browser.close();
}

run().catch(err => {
  console.error('Final test error:', err);
  process.exit(1);
});
