// Scalar entry points into the unmodified netDxf assembly. These signatures can
// be called directly from JavaScript or exported from the native Wasm compiler.
// Angles use radians, matching netDxf's Vector/Matrix geometry API.
using netDxf;

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
    }
}
