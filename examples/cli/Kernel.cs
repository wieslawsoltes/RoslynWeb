public static class Kernel
{
    public static long Add(long left, long right) => checked(left + right);

    public static long Sum(int count)
    {
        long total = 0;
        for (int i = 0; i <= count; i++) total += i;
        return total;
    }

    public static double Average(double left, double right) => (left + right) / 2;
}
