# AutoTrack — Car Repair Tracker

Track car repairs, parts replaced, and generate PDF reports.
Static front-end (HTML/CSS/JS + Tailwind CDN + jsPDF). Fully responsive.

## Project Structure

```
car-repair-tracker/
├── index.html          # main markup
├── css/
│   └── styles.css      # custom styles + responsive breakpoints
├── js/
│   └── script.js       # navigation, dynamic rows, PDF generation
└── README.md
```

## Run Locally

Just open `index.html` in a browser — no build step needed.

For best results (some browsers restrict local file access), serve it through a tiny dev server:

```bash
# Option 1 — Python
python -m http.server 8000

# Option 2 — Node
npx serve .

# Option 3 — VS Code "Live Server" extension
```

Then visit `http://localhost:8000`.

## Hosting (free options)

Because it's pure static files, you can host it anywhere:

### 1. GitHub Pages (recommended)
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/car-repair-tracker.git
git push -u origin main
```
Then in your repo on GitHub: **Settings → Pages → Source: main / root → Save**.
Your site will be live at `https://<your-username>.github.io/car-repair-tracker/`.

### 2. Netlify (drag & drop)
Go to [app.netlify.com/drop](https://app.netlify.com/drop) and drag the entire folder onto the page. Done.

### 3. Vercel
```bash
npm i -g vercel
vercel
```

### 4. Cloudflare Pages
Connect your GitHub repo at [pages.cloudflare.com](https://pages.cloudflare.com).

## Responsive Breakpoints

| Width        | Layout |
|--------------|--------|
| > 1024px     | Full sidebar, 4-col stats, 3-col cars |
| 768–1024px   | Full sidebar, 2-col stats, 2-col cars |
| < 768px      | Hamburger menu, stacked single-column |
| < 480px      | Tighter padding, smaller headings |

A hamburger button appears on mobile. Tap it to open the sidebar; tap the dimmed area or press **Esc** to close.

## Features

- Dashboard with stats and recent repairs
- Add / view cars with brand, plate, owner info
- Log repairs with dynamic part/labor rows (auto-calculated totals)
- Repair history timeline per car
- One-click PDF export with vehicle info, items table, signature lines
- Fully responsive (desktop, tablet, mobile)

## Next Steps (when you're ready)

The current version uses **in-memory data** — refreshing the page resets it.
To make it production-ready:

1. **Backend:** Node.js + Express or Python + Flask
2. **Database:** PostgreSQL (recommended) or SQLite
3. **Server-side PDF:** `pdfkit` (Node) or `reportlab` (Python)
4. **Authentication:** add user accounts for mechanic vs admin roles
5. **Photo uploads:** attach images to each repair

Let me know when you want to add the backend.
