import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

const CONFIG_FILE = '.shadow-sync.json';

export function saveConfig(roomId, passphrase) {
  try {
    const cwd = process.cwd();
    const configPath = path.join(cwd, CONFIG_FILE);
    const configData = JSON.stringify({ roomId, passphrase }, null, 2);
    
    fs.writeFileSync(configPath, configData, 'utf-8');
    
    // Security Auto-Injection
    const gitignorePath = path.join(cwd, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      if (!gitignoreContent.includes(CONFIG_FILE)) {
        fs.appendFileSync(gitignorePath, `\n${CONFIG_FILE}\n`, 'utf-8');
        console.log(chalk.blue(`ℹ Added ${CONFIG_FILE} to .gitignore`));
      }
    }
    
    return true;
  } catch (error) {
    console.error(chalk.red(`✖ Failed to save configuration: ${error.message}`));
    return false;
  }
}

export function loadConfig() {
  try {
    const cwd = process.cwd();
    const configPath = path.join(cwd, CONFIG_FILE);
    
    if (!fs.existsSync(configPath)) {
      return null;
    }
    
    const configData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(configData);
  } catch (error) {
    console.error(chalk.red(`✖ Failed to load configuration: ${error.message}`));
    return null;
  }
}
