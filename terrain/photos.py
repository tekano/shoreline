"""Photo references: read where, when and how each of my photos was taken, so the scene can
stand in the same spot, face the same way, use the same lens and set the same sun.

    python terrain/photos.py

Reads  refs/*.jpg            (private: family photos, git-ignored)
Writes refs/photos.json      (git-ignored too; the page shows the Photo menu only if it exists)

From the EXIF: GPS position (to scene x, z), compass heading if the phone saved one, the
35 mm-equivalent focal length (to a vertical field of view for the photo's own shape after
rotation), and the local date and time (to the sky clock's day of year and hour).
Panoramas are left out here (they need their own projection).
"""
import glob, json, os, math
import numpy as np
from PIL import Image, ImageOps
from PIL.ExifTags import TAGS, GPSTAGS
from osgb import wgs84_to_osgb

HERE = os.path.dirname(os.path.abspath(__file__))
REFS = os.path.join(os.path.dirname(HERE), 'refs')
META = os.path.join(os.path.dirname(HERE), 'walney', 'data', 'meta.json')


def dms(v, ref):
    d = float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
    return -d if ref in ('S', 'W') else d


def main():
    origin = json.load(open(META))['origin_osgb']
    out = []
    for path in sorted(glob.glob(os.path.join(REFS, '*.jpg'))):
        name = os.path.basename(path)
        if 'PANO' in name or 'pano' in name:
            continue
        im = Image.open(path)
        ex = im.getexif()
        info = {TAGS.get(k, k): v for k, v in ex.items()}
        info.update({TAGS.get(k, k): v for k, v in ex.get_ifd(0x8769).items()})
        gps = {GPSTAGS.get(k, k): v for k, v in ex.get_ifd(0x8825).items()}
        w, h = ImageOps.exif_transpose(im).size
        f35 = float(info.get('FocalLengthIn35mmFilm') or 27)        # Pixel main camera when missing
        diag = 2 * math.atan(43.27 / (2 * f35))                       # diagonal field of view
        vfov = math.degrees(2 * math.atan(math.tan(diag / 2) * h / math.hypot(w, h)))
        rec = {'file': name, 'aspect': round(w / h, 4), 'vfov': round(vfov, 2), 'f35': f35}
        t = info.get('DateTimeOriginal')
        if t:
            d, c = t.split(' ')
            y, mo, da = map(int, d.split(':'))
            hh, mi, ss = map(int, c.split(':'))
            rec['year'] = y
            rec['day'] = int((np.datetime64(f'{y:04d}-{mo:02d}-{da:02d}') - np.datetime64(f'{y:04d}-01-01')).astype(int)) + 1
            rec['time'] = round(hh + mi / 60 + ss / 3600, 3)                  # local clock time, as the sky clock uses
            rec['label'] = f'{da} {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mo-1]} {y} {hh:02d}:{mi:02d}'
        if 'GPSLatitude' in gps:
            lat = dms(gps['GPSLatitude'], gps.get('GPSLatitudeRef'))
            lon = dms(gps['GPSLongitude'], gps.get('GPSLongitudeRef'))
            e, n = wgs84_to_osgb(np.array([lat]), np.array([lon]))
            rec['pos'] = [round(float(e[0] - origin[0]), 1), round(float(-(n[0] - origin[1])), 1)]
            if 'GPSImgDirection' in gps:
                rec['heading'] = round(float(gps['GPSImgDirection']), 1)
        out.append(rec)
    # hand corrections (refs/photos-fix.json): headings, pitch, and places for photos without GPS
    fixp = os.path.join(REFS, 'photos-fix.json')
    fix = json.load(open(fixp)) if os.path.exists(fixp) else {}
    for r in out:
        for k, v in fix.get(r['file'], {}).items():
            if k != 'why':
                r[k] = v
    json.dump(out, open(os.path.join(REFS, 'photos.json'), 'w'), indent=1)
    for r in out:
        print(r.get('label'), r['file'], 'pos' in r and r['pos'], r.get('heading'), r['vfov'])


if __name__ == '__main__':
    main()
