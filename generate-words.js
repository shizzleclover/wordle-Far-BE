// Generate word lists for 4, 6, 7 letter words from the dwyl english-words dictionary
const fs = require('fs');
const path = require('path');
const https = require('https');

const url = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';

function fetchWords() {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching full English dictionary...');
  const data = await fetchWords();
  
  const allWords = data
    .split(/\r?\n/)
    .map(w => w.trim().toLowerCase())
    .filter(w => /^[a-z]+$/.test(w));

  console.log(`Total words fetched: ${allWords.length}`);

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Only generate for lengths we're missing (4, 6, 7)
  // Keep existing 5-letter list from Wordle source
  for (const len of [4, 6, 7]) {
    const filtered = allWords.filter(w => w.length === len);
    const filePath = path.join(dataDir, `words-${len}.json`);
    fs.writeFileSync(filePath, JSON.stringify(filtered, null, 0));
    console.log(`words-${len}.json: ${filtered.length} words`);
  }

  console.log('Done!');
}

main().catch(console.error);
