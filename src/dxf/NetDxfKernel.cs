// Scalar entry points into the unmodified netDxf assembly. These signatures can
// be called directly from JavaScript or exported from the native Wasm compiler.
// Angles use radians, matching netDxf's Vector/Matrix geometry API.
using netDxf;
using netDxf.Entities;

namespace RoslynWeb.Dxf
{
    public static class NetDxfKernel
    {
        public static double Distance2(double ax, double ay, double bx, double by)
            => Vector2.Distance(new Vector2(ax, ay), new Vector2(bx, by));

        public static double Distance3(double ax, double ay, double az, double bx, double by, double bz)
            => Vector3.Distance(new Vector3(ax, ay, az), new Vector3(bx, by, bz));

        public static double RotateX(double x, double y, double angle)
            => (Matrix3.RotationZ(angle) * new Vector3(x, y, 0.0)).X;

        public static double RotateY(double x, double y, double angle)
            => (Matrix3.RotationZ(angle) * new Vector3(x, y, 0.0)).Y;

        public static double CrossZ(double ax, double ay, double bx, double by)
            => Vector3.CrossProduct(new Vector3(ax, ay, 0.0), new Vector3(bx, by, 0.0)).Z;

        public static double NormalizeAngle(double degrees) => MathHelper.NormalizeAngle(degrees);

        public static double CubicBezierCoordinate(double p0, double p1, double p2, double p3, double t)
            => new BezierCurveCubic(new Vector3(p0, 0.0, 0.0), new Vector3(p1, 0.0, 0.0),
                new Vector3(p2, 0.0, 0.0), new Vector3(p3, 0.0, 0.0)).CalculatePoint(t).X;

        // These entry points execute actual entity constructors and properties,
        // including netDxf validation and the entity initialization event path.
        public static double LineLength(double ax, double ay, double az, double bx, double by, double bz)
        {
            var line = new Line(new Vector3(ax, ay, az), new Vector3(bx, by, bz));
            return Vector3.Distance(line.StartPoint, line.EndPoint);
        }

        public static double CircleArea(double radius)
        {
            var circle = new Circle(Vector3.Zero, radius);
            return System.Math.PI * circle.Radius * circle.Radius;
        }

        public static double ArcSweep(double startDegrees, double endDegrees)
        {
            var arc = new Arc(Vector3.Zero, 1.0, startDegrees, endDegrees);
            return MathHelper.NormalizeAngle(arc.EndAngle - arc.StartAngle);
        }

        public static int TrueColorArgb(int red, int green, int blue)
        {
            if (red < 0 || red > 255) throw new System.ArgumentOutOfRangeException(nameof(red));
            if (green < 0 || green > 255) throw new System.ArgumentOutOfRangeException(nameof(green));
            if (blue < 0 || blue > 255) throw new System.ArgumentOutOfRangeException(nameof(blue));
            return new AciColor((byte)red, (byte)green, (byte)blue).ToColor().ToArgb();
        }
    }
}
