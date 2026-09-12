using System;
using System.IO;
public static class FileExceptionsFixture {
    private static string Snapshot(FileNotFoundException e){return e.FileName+"|"+e.Message+"|"+e.InnerException?.Message+"|"+(e.FusionLog==null)+"|"+(e is IOException)+"|"+(e is SystemException);}
    private static string Snapshot(FileLoadException e){return e.FileName+"|"+e.Message+"|"+e.InnerException?.Message+"|"+(e.FusionLog==null)+"|"+(e is IOException)+"|"+(e is SystemException);}
    public static string[] ExplicitMetadata(){var inner=new InvalidOperationException("inner");return new[]{Snapshot(new FileNotFoundException("message","a.dxf")),Snapshot(new FileNotFoundException("message","a.dxf",inner)),Snapshot(new FileNotFoundException("",null,inner)),Snapshot(new FileNotFoundException("message",inner)),Snapshot(new FileLoadException("message","b.dxf")),Snapshot(new FileLoadException("message","b.dxf",inner)),Snapshot(new FileLoadException("",null,inner)),Snapshot(new FileLoadException("message",inner))};}
    public static string[] DefaultMessages(){return new[]{new FileNotFoundException().Message,new FileNotFoundException((string)null).Message,new FileNotFoundException(null,"a.dxf").Message,new FileNotFoundException(null,(string)null).Message,new FileNotFoundException(null,"").Message,new FileLoadException().Message,new FileLoadException((string)null).Message,new FileLoadException(null,"a.dxf").Message,new FileLoadException(null,(string)null).Message,new FileLoadException(null,"").Message};}
    public static string[] ToStrings(){var inner=new InvalidOperationException("inner");return new[]{new FileNotFoundException("message","a.dxf").ToString(),new FileNotFoundException("message","a.dxf",inner).ToString(),new FileNotFoundException("",null,inner).ToString(),new FileLoadException("message","b.dxf").ToString(),new FileLoadException("message","b.dxf",inner).ToString(),new FileLoadException("",null,inner).ToString()};}
    public static string CatchHierarchy(){try{throw new FileLoadException("Could not read","document.dxf",new IOException("inner"));}catch(IOException e){var f=(FileLoadException)e;return (e is SystemException)+"|"+f.FileName+"|"+f.Message+"|"+f.InnerException.Message;}}
    public class CustomFileException : FileLoadException {
        public int Untouched;
        public long UntouchedLong;
        public string UntouchedText;
        protected readonly int code;
        public CustomFileException(int value) : base("custom", "document.dxf") { code=value; }
        public virtual int Version { get { return code; } }
    }
    public sealed class DerivedIssue : CustomFileException {
        public int UntouchedDerived;
        public int Additional;
        public DerivedIssue(int value) : base(value) { Additional=value+1; }
        public override int Version { get { return base.Version+Additional; } }
    }
    public sealed class PlainProblem : Exception {
        public int Untouched;
        public string UntouchedText;
        public PlainProblem() : base("plain") { }
    }
    public static string[] CustomFields() {
        var result=new string[3];var value=new DerivedIssue(7);CustomFileException parent=value;
        result[0]=parent.Untouched+"|"+parent.UntouchedLong+"|"+(parent.UntouchedText==null)+"|"+value.UntouchedDerived+"|"+parent.Version;
        try { throw value; } catch(IOException caught) {var actual=(DerivedIssue)caught;result[1]=actual.Version+"|"+actual.FileName+"|"+actual.Message;}
        try { throw new PlainProblem(); } catch(Exception caught) {var actual=(PlainProblem)caught;result[2]=actual.Untouched+"|"+(actual.UntouchedText==null)+"|"+actual.Message;}
        return result;
    }
    public static int Characters(){int sum=0;for(int i=0;i<65536;i++){int value=Convert.ToInt32((char)i);if(value!=i)throw new Exception("Character conversion mismatch.");sum+=value;}return sum;}
}
