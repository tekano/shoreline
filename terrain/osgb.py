"""WGS84 latitude/longitude → British National Grid (OSGB36) easting/northing.

Helmert datum shift plus Transverse Mercator, after the Ordnance Survey's
"A guide to coordinate systems in Great Britain". Accurate to a few metres,
which is plenty for placing a camera.
"""
from math import radians, sin, cos, tan, sqrt, atan2


def _to_cartesian(lat, lon, a, b, h=0.0):
    e2 = 1 - (b * b) / (a * a)
    nu = a / sqrt(1 - e2 * sin(lat) ** 2)
    return ((nu + h) * cos(lat) * cos(lon), (nu + h) * cos(lat) * sin(lon), ((1 - e2) * nu + h) * sin(lat))


def _to_latlon(x, y, z, a, b):
    e2 = 1 - (b * b) / (a * a)
    p = sqrt(x * x + y * y)
    lat = atan2(z, p * (1 - e2))
    for _ in range(10):
        nu = a / sqrt(1 - e2 * sin(lat) ** 2)
        lat = atan2(z + e2 * nu * sin(lat), p)
    return lat, atan2(y, x)


def wgs84_to_osgb(lat_deg, lon_deg):
    # WGS84 → OSGB36 Helmert (OS published parameters)
    x, y, z = _to_cartesian(radians(lat_deg), radians(lon_deg), 6378137.0, 6356752.3141)
    tx, ty, tz, s = -446.448, 125.157, -542.060, 20.4894e-6
    rx, ry, rz = (radians(v / 3600) for v in (-0.1502, -0.2470, -0.8421))
    x2 = tx + (1 + s) * x - rz * y + ry * z
    y2 = ty + rz * x + (1 + s) * y - rx * z
    z2 = tz - ry * x + rx * y + (1 + s) * z
    lat, lon = _to_latlon(x2, y2, z2, 6377563.396, 6356256.909)
    return osgb36_tm(lat, lon)


def osgb36_tm(lat, lon):
    """OSGB36 latitude/longitude (radians) → National Grid easting/northing."""
    a, b = 6377563.396, 6356256.909  # Airy 1830
    F0, lat0, lon0, E0, N0 = 0.9996012717, radians(49), radians(-2), 400000, -100000
    e2 = 1 - (b * b) / (a * a)
    n = (a - b) / (a + b)
    nu = a * F0 / sqrt(1 - e2 * sin(lat) ** 2)
    rho = a * F0 * (1 - e2) / (1 - e2 * sin(lat) ** 2) ** 1.5
    eta2 = nu / rho - 1
    dl, dp = lat - lat0, lat + lat0
    M = b * F0 * ((1 + n + 1.25 * n * n + 1.25 * n ** 3) * dl
                  - (3 * n + 3 * n * n + 21 / 8 * n ** 3) * sin(dl) * cos(dp)
                  + (15 / 8 * n * n + 15 / 8 * n ** 3) * sin(2 * dl) * cos(2 * dp)
                  - 35 / 24 * n ** 3 * sin(3 * dl) * cos(3 * dp))
    c, t = cos(lat), tan(lat)
    I = M + N0
    II = nu / 2 * sin(lat) * c
    III = nu / 24 * sin(lat) * c ** 3 * (5 - t * t + 9 * eta2)
    IIIA = nu / 720 * sin(lat) * c ** 5 * (61 - 58 * t * t + t ** 4)
    IV = nu * c
    V = nu / 6 * c ** 3 * (nu / rho - t * t)
    VI = nu / 120 * c ** 5 * (5 - 18 * t * t + t ** 4 + 14 * eta2 - 58 * t * t * eta2)
    d = lon - lon0
    return E0 + IV * d + V * d ** 3 + VI * d ** 5, I + II * d * d + III * d ** 4 + IIIA * d ** 6


if __name__ == '__main__':
    # OS guide worked example (Annex C): 52°39'27.2531"N 1°43'4.5177"E → 651409.903, 313177.270
    lat = radians(52 + 39 / 60 + 27.2531 / 3600); lon = radians(1 + 43 / 60 + 4.5177 / 3600)
    print([round(v, 3) for v in osgb36_tm(lat, lon)])
