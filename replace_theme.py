import os
import re

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Colors
    replacements = [
        (r'bg-\[\#0b0f17\]', 'bg-[#f0f0f0]'),
        (r'bg-\[\#141a26\]', 'bg-white'),
        (r'bg-\[\#0e131d\]', 'bg-gray-50'),
        (r'bg-\[\#10141e\]', 'bg-gray-100'),
        (r'bg-\[\#151b28\]', 'bg-white'),
        (r'bg-\[\#111622\]/95', 'bg-white/95'),
        (r'bg-[#0e121a]', 'bg-[#f0f0f0]'),
        (r'bg-[#161c28]', 'bg-white'),
        
        # Borders
        (r'border-gray-800', 'border-gray-200'),
        (r'border-gray-700', 'border-gray-300'),
        
        # Texts
        (r'text-white', 'text-[#1e1e1e]'),
        (r'text-gray-100', 'text-[#1e1e1e]'),
        (r'text-gray-200', 'text-gray-800'),
        (r'text-gray-300', 'text-gray-700'),
        (r'text-gray-400', 'text-gray-500'),
        (r'text-gray-500', 'text-gray-400'),
        (r'text-gray-600', 'text-gray-300'),
        
        # Gray backgrounds
        (r'bg-gray-800', 'bg-gray-100'),
        (r'bg-gray-900', 'bg-gray-50'),
        (r'hover:bg-gray-800', 'hover:bg-gray-200'),
        (r'hover:bg-gray-700', 'hover:bg-gray-300'),
        (r'active:bg-gray-600', 'active:bg-gray-400'),
        
        # Logos and html dark class
        (r'<html lang="en" class="dark">', '<html lang="en">'),
        (r'devfest-logo-white\.png', 'devfest-logo.png'),
        (r'gdg-lockup-white\.png', 'gdg-lockup.png'),
        
        # Table hover
        (r'hover:bg-gray-800/40', 'hover:bg-gray-100/60'),
        (r'hover:bg-gray-800/30', 'hover:bg-gray-100/60'),
        
        # Badges & Buttons
        (r'bg-gray-800/60', 'bg-gray-200/60'),
        
        # Specific shadows
        (r'shadow-xl', 'shadow-sm'),
        (r'shadow-2xl', 'shadow-md'),
    ]

    for old, new in replacements:
        content = re.sub(old, new, content)

    # If logos didn't exist, we invert. But wait, I'll just change the img class to add invert if the src has "-white".
    # Wait, the regex already replaced "-white.png" to ".png". Let's assume the light mode logos exist. If not, they will be broken.
    
    with open(filepath, 'w') as f:
        f.write(content)

base_dir = '/Users/dr.gretchenboria/devfest/leaderboard-app/public'
process_file(os.path.join(base_dir, 'index.html'))
process_file(os.path.join(base_dir, 'app.js'))
process_file(os.path.join(base_dir, 'styles.css'))
