from pathlib import Path
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "icons"
INK = "#18332b"
LIME = "#dff277"
GREEN = "#62c49a"


def build_master() -> Image.Image:
    size = 1024
    image = Image.new("RGB", (size, size), INK)
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle((246, 338, 346, 738), radius=32, fill=LIME)
    draw.rounded_rectangle((678, 338, 778, 738), radius=32, fill=LIME)

    points = []
    for step in range(101):
        t = step / 100
        x = (1 - t) ** 2 * 296 + 2 * (1 - t) * t * 512 + t ** 2 * 728
        y = (1 - t) ** 2 * 535 + 2 * (1 - t) * t * 300 + t ** 2 * 535
        points.append((round(x), round(y)))
    draw.line(points, fill=GREEN, width=58, joint="curve")

    draw.ellipse((477, 366, 547, 436), fill=LIME)
    return image


def save_icon(master: Image.Image, filename: str, size: int) -> None:
    icon = master.resize((size, size), Image.Resampling.LANCZOS)
    icon.save(ICONS / filename, format="PNG", optimize=True)


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    master = build_master()
    save_icon(master, "icon-512.png", 512)
    save_icon(master, "icon-maskable-512.png", 512)
    save_icon(master, "icon-192.png", 192)
    save_icon(master, "apple-touch-icon.png", 180)
    save_icon(master, "favicon-32.png", 32)


if __name__ == "__main__":
    main()
