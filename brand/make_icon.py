"""Generates the Argus app icon: Argus Panoptes, the hundred-eyed watchman.

An egg-shaped head packed with eyes that swirl around one great central eye, on
the orange Heimdall tile. Deterministic (fixed seed), so re-running gives the
same icon. Writes argus-icon.svg (full-bleed square, for app icons) and
argus-mark.svg (head only, transparent, for the web and adaptive icons).
"""
import math
import random

random.seed(7)

CX, CY = 512, 518          # head centre
RX, RY = 300, 356          # head half-width / half-height
BIG = (512, 478, 148)      # the central eye: x, y, radius

LID, BALL, FLESH, INK = '#F4B993', '#FFF3E8', '#A9431F', '#3A1107'


def inside(x, y, r):
    """Is a circle of radius r fully inside the (slightly egg-shaped) head?"""
    ry = RY - r if y < CY else RY * 0.94 - r   # a little narrower towards the chin
    rx = RX - r
    if rx <= 0 or ry <= 0:
        return False
    return ((x - CX) / rx) ** 2 + ((y - CY) / ry) ** 2 <= 1


def almond(hw, hh):
    return f'M{-hw:.1f} 0 Q0 {-2 * hh:.1f} {hw:.1f} 0 Q0 {2 * hh:.1f} {-hw:.1f} 0 Z'


def eye(x, y, r, angle, iris='url(#iris)', big=False):
    sw = max(3.0, r * 0.11)
    out = [f'<g transform="translate({x:.1f} {y:.1f}) rotate({angle:.1f})">']
    out.append(f'<path d="{almond(1.14 * r, 0.74 * r)}" fill="{LID}" stroke="{INK}" stroke-width="{sw:.1f}" stroke-linejoin="round"/>')
    out.append(f'<path d="{almond(0.96 * r, 0.56 * r)}" fill="{BALL}" stroke="{INK}" stroke-width="{sw * 0.7:.1f}" stroke-linejoin="round"/>')
    # The iris stays upright so every eye looks straight at you.
    out.append(f'<g transform="rotate({-angle:.1f})">')
    out.append(f'<circle r="{0.47 * r:.1f}" fill="{iris}" stroke="{INK}" stroke-width="{sw * 0.55:.1f}"/>')
    out.append(f'<circle r="{0.21 * r:.1f}" fill="#0E0A09"/>')
    out.append(f'<circle cx="{-0.16 * r:.1f}" cy="{-0.17 * r:.1f}" r="{max(1.5, 0.085 * r):.1f}" fill="#FFFFFF"/>')
    out.append('</g></g>')
    return ''.join(out)


# Pack eyes around the central one, big ones first. Eyes may overlap a little and
# the outer ones bulge past the head's edge, so the silhouette itself is made of eyes.
placed = [BIG]
sizes = [80] * 3 + [66] * 6 + [54] * 10 + [44] * 16 + [35] * 26 + [28] * 40 + [22] * 60 + [17] * 90 + [13] * 140
for r in sizes:
    for _ in range(6000):
        x = random.uniform(CX - RX - 20, CX + RX + 20)
        y = random.uniform(CY - RY - 20, CY + RY + 20)
        if not inside(x, y, r * 0.3):
            continue
        if all(math.hypot(x - px, y - py) > (r + pr) * 0.86 for px, py, pr in placed):
            placed.append((x, y, r))
            break

eyes = []
for x, y, r in sorted(placed[1:], key=lambda e: e[2]):   # small first: big eyes sit on top
    # Lids follow circles around the great eye, like a swirl; a little jitter keeps it organic.
    a = math.degrees(math.atan2(y - BIG[1], x - BIG[0])) + 90 + random.uniform(-16, 16)
    if a > 90:
        a -= 180
    eyes.append(eye(x, y, r, a))

# Flesh tendrils swirling around the great eye, behind everything.
tendrils = []
for _ in range(46):
    rad = random.uniform(150, 360)
    t0 = random.uniform(0, 2 * math.pi)
    t1 = t0 + random.uniform(0.5, 1.4)
    k = random.uniform(0.86, 1.0)
    x0, y0 = BIG[0] + math.cos(t0) * rad, BIG[1] + math.sin(t0) * rad * 1.1
    x1, y1 = BIG[0] + math.cos(t1) * rad * k, BIG[1] + math.sin(t1) * rad * 1.1 * k
    tendrils.append(f'<path d="M{x0:.0f} {y0:.0f} A{rad:.0f} {rad * 1.1:.0f} 0 0 1 {x1:.0f} {y1:.0f}" '
                    f'stroke-width="{random.uniform(5, 11):.1f}"/>')

head = (f'<path d="M{CX} {CY - RY} C{CX + RX * 0.66} {CY - RY} {CX + RX} {CY - RY * 0.52} {CX + RX} {CY - 20} '
        f'C{CX + RX} {CY + RY * 0.55} {CX + RX * 0.58} {CY + RY * 0.96} {CX} {CY + RY * 0.96} '
        f'C{CX - RX * 0.58} {CY + RY * 0.96} {CX - RX} {CY + RY * 0.55} {CX - RX} {CY - 20} '
        f'C{CX - RX} {CY - RY * 0.52} {CX - RX * 0.66} {CY - RY} {CX} {CY - RY} Z"')

defs = '''<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7925F"/><stop offset="1" stop-color="#D9552C"/></linearGradient>
  <radialGradient id="flesh" cx="0.5" cy="0.42" r="0.6"><stop offset="0" stop-color="#C85A2C"/><stop offset="1" stop-color="#8E3417"/></radialGradient>
  <radialGradient id="iris" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#8FD0FF"/><stop offset="0.55" stop-color="#3E86CF"/><stop offset="1" stop-color="#1B3F77"/></radialGradient>
  <radialGradient id="bigiris" cx="0.42" cy="0.38" r="0.7"><stop offset="0" stop-color="#B8E4FF"/><stop offset="0.35" stop-color="#5AA7EA"/><stop offset="0.8" stop-color="#2A5FA8"/><stop offset="1" stop-color="#15305E"/></radialGradient>
  <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0.55" stop-color="#FFD9B8" stop-opacity="0.55"/><stop offset="1" stop-color="#FFD9B8" stop-opacity="0"/></radialGradient>
</defs>'''


def body():
    bx, by, br = BIG
    parts = [f'<path {head[6:]} fill="url(#flesh)" stroke="{INK}" stroke-width="14" stroke-linejoin="round"/>']
    parts.append('<clipPath id="headclip"><path ' + head[6:] + '/></clipPath>')
    parts.append('<g clip-path="url(#headclip)" fill="none" stroke="#6E260F" stroke-linecap="round" stroke-opacity="0.8">' + ''.join(tendrils) + '</g>')
    parts.append(f'<circle cx="{bx}" cy="{by}" r="{br * 1.5:.0f}" fill="url(#halo)"/>')   # glow behind the eyes
    parts += eyes
    parts.append(eye(bx, by, br, 0, iris='url(#bigiris)', big=True))
    # Iris detail on the great eye: fibres radiating from the pupil.
    fibres = ''.join(
        f'<line x1="{bx + math.cos(t) * br * 0.25:.1f}" y1="{by + math.sin(t) * br * 0.25:.1f}" '
        f'x2="{bx + math.cos(t) * br * 0.44:.1f}" y2="{by + math.sin(t) * br * 0.44:.1f}"/>'
        for t in [i * math.pi / 12 for i in range(24)])
    parts.append(f'<g stroke="#1B3F77" stroke-width="3" stroke-opacity="0.55">{fibres}</g>')
    parts.append(f'<circle cx="{bx}" cy="{by}" r="{br * 0.21:.1f}" fill="#0E0A09"/>')
    parts.append(f'<circle cx="{bx - br * 0.16:.1f}" cy="{by - br * 0.17:.1f}" r="{br * 0.085:.1f}" fill="#FFFFFF"/>')
    return '\n'.join(parts)


svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n{defs}\n'
open('argus-icon.svg', 'w').write(svg + '<rect width="1024" height="1024" fill="url(#bg)"/>\n' + body() + '\n</svg>\n')
open('argus-mark.svg', 'w').write(svg + body() + '\n</svg>\n')
print(f'{len(placed)} eyes')
