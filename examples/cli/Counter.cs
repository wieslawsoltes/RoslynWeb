public sealed class Counter
{
    public int Value { get; set; }
    public int Add(int amount) => Value += amount;
}
